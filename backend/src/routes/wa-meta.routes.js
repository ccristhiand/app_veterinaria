'use strict';

/**
 * VetClinic SaaS — WhatsApp Meta (API oficial) desde la pantalla de la clínica
 * Base: /api/v1/wa-meta   (pasa por resolveTenant → req.tenant, req.db)
 *
 *   GET  /estado      → si el botón puede activarse + estado de la conexión de la clínica
 *   POST /conectar    → recibe el "code" de Embedded Signup, lo cambia por el token de la
 *                       clínica, suscribe la app a su cuenta de WhatsApp, pide la
 *                       sincronización de contactos e historial (coexistencia) y guarda todo
 *   POST /desconectar → quita la suscripción y borra el token
 *
 * La configuración de la plataforma (App ID, App Secret, Configuration ID) se lee de
 * vet_master.saas_config (panel admin → WhatsApp → Configuración Meta).
 */

const { Router }  = require('express');
const crypto      = require('crypto');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { masterQuery } = require('../config/masterDB');
const { encrypt, decrypt } = require('../services/crypto.service');
const logger      = require('../config/logger');

const router = Router();
router.use(authenticate, authorize('admin'));

const GRAPH_BASE = (process.env.META_GRAPH_BASE || 'https://graph.facebook.com').replace(/\/+$/, '');

// ── Utilidades ──────────────────────────────────────────────────────

// Id real de la clínica (no se usa req.tenant.id porque tenant_config.id lo pisa en el JOIN)
async function tenantIdDe(req) {
  const [t] = await masterQuery('SELECT id FROM tenants WHERE db_name = ? LIMIT 1', [req.tenant.db_name]);
  if (!t) { const e = new Error('Clínica no encontrada.'); e.status = 404; throw e; }
  return t.id;
}

async function configPlataforma() {
  const rows = await masterQuery(
    `SELECT clave, valor FROM saas_config
     WHERE clave IN ('meta_app_id','meta_app_secret','meta_config_id','meta_graph_version')`
  );
  const m = Object.fromEntries(rows.map(r => [r.clave, r.valor]));
  let secret = null;
  if (m.meta_app_secret) { try { secret = decrypt(m.meta_app_secret); } catch { secret = null; } }
  return {
    appId   : m.meta_app_id || '',
    configId: m.meta_config_id || '',
    graphVer: m.meta_graph_version || 'v25.0',
    secret,
    lista   : !!(m.meta_app_id && m.meta_config_id && secret),
  };
}

async function verMetaHabilitado(tenantId) {
  const [r] = await masterQuery('SELECT ver_meta FROM wa_config_global WHERE tenant_id = ?', [tenantId]);
  return !!(r && Number(r.ver_meta));
}

// Llamada a Graph API con mensaje de error legible
async function graph(method, path, { token, query, body, cfg } = {}) {
  const url = new URL(`${GRAPH_BASE}/${cfg.graphVer}/${path.replace(/^\/+/, '')}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const opts = { method, headers: {}, signal: AbortSignal.timeout(15000) };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }

  let r, d;
  try {
    r = await fetch(url, opts);
    d = await r.json().catch(() => ({}));
  } catch (e) {
    const err = new Error('No se pudo conectar con Meta: ' + e.message); err.status = 502; throw err;
  }
  if (!r.ok || d.error) {
    const err = new Error(d.error?.error_user_msg || d.error?.message || `Meta respondió ${r.status}`);
    err.status = 422; err.meta = d.error; throw err;
  }
  return d;
}

function vistaCuenta(c) {
  if (!c) return { estado: 'desconectado' };
  return {
    estado           : c.estado,
    numero_display   : c.numero_display,
    nombre_verificado: c.nombre_verificado,
    coexistencia     : !!c.coexistencia,
    historial_sync   : c.historial_sync,
    calidad          : c.calidad,
    conectado_at     : c.conectado_at,
    ultimo_error     : c.ultimo_error,
  };
}

// ── GET /estado ─────────────────────────────────────────────────────
router.get('/estado', async (req, res, next) => {
  try {
    const tenantId = await tenantIdDe(req);
    const cfg      = await configPlataforma();
    const verMeta  = await verMetaHabilitado(tenantId);
    const [cuenta] = await masterQuery('SELECT * FROM wa_meta_cuentas WHERE tenant_id = ?', [tenantId]);

    return res.json({
      success: true,
      data: {
        ...vistaCuenta(cuenta),
        ver_meta        : verMeta,
        plataforma_lista: cfg.lista,
        // Datos públicos que necesita el SDK de Facebook (el App Secret nunca sale de aquí)
        app_id          : cfg.lista ? cfg.appId : null,
        config_id       : cfg.lista ? cfg.configId : null,
        graph_ver       : cfg.graphVer,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /conectar ──────────────────────────────────────────────────
router.post('/conectar', async (req, res, next) => {
  const tenantId = await tenantIdDe(req).catch(e => { next(e); return null; });
  if (!tenantId) return;

  try {
    const cfg = await configPlataforma();
    if (!cfg.lista) return res.status(409).json({ success: false, message: 'La plataforma aún no tiene configurado WhatsApp Meta.' });
    if (!(await verMetaHabilitado(tenantId))) return res.status(403).json({ success: false, message: 'WhatsApp Meta no está habilitado para esta clínica.' });

    const code   = String(req.body.code || '').trim();
    const evento = String(req.body.evento || '');
    let wabaId   = String(req.body.waba_id || '').trim() || null;
    let phoneId  = String(req.body.phone_number_id || '').trim() || null;
    const bizId  = String(req.body.business_id || '').trim() || null;
    if (!code) return res.status(422).json({ success: false, message: 'Falta el código de autorización de Meta.' });

    await masterQuery(
      `INSERT INTO wa_meta_cuentas (tenant_id, estado) VALUES (?, 'conectando')
       ON DUPLICATE KEY UPDATE estado = 'conectando', ultimo_error = NULL`, [tenantId]
    );

    // 1) Cambiar el code por el token de la clínica (vence en 30 s: va primero)
    const tok = await graph('GET', 'oauth/access_token', {
      cfg, query: { client_id: cfg.appId, client_secret: cfg.secret, code },
    });
    const token = tok.access_token;
    if (!token) throw Object.assign(new Error('Meta no devolvió el token de la clínica.'), { status: 422 });

    // 2) Si la ventana no envió los ids, se averiguan con el token
    if (!wabaId) {
      const dbg = await graph('GET', 'debug_token', {
        cfg, query: { input_token: token, access_token: `${cfg.appId}|${cfg.secret}` },
      });
      const scope = (dbg.data?.granular_scopes || []).find(s => s.scope === 'whatsapp_business_management');
      wabaId = scope?.target_ids?.[0] || null;
    }
    if (!wabaId) throw Object.assign(new Error('No se pudo identificar la cuenta de WhatsApp de la clínica.'), { status: 422 });

    if (!phoneId) {
      const nums = await graph('GET', `${wabaId}/phone_numbers`, { cfg, token });
      phoneId = nums.data?.[0]?.id || null;
    }
    if (!phoneId) throw Object.assign(new Error('La cuenta de WhatsApp no tiene números.'), { status: 422 });

    // El número no puede estar conectado a otra clínica
    const [otro] = await masterQuery(
      'SELECT tenant_id FROM wa_meta_cuentas WHERE phone_number_id = ? AND tenant_id <> ? LIMIT 1',
      [phoneId, tenantId]
    );
    if (otro) return res.status(409).json({ success: false, message: 'Ese número ya está conectado a otra clínica.' });

    // 3) Datos del número
    const info = await graph('GET', phoneId, {
      cfg, token,
      query: { fields: 'display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type' },
    });
    const coexistencia = evento === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' || info.is_on_biz_app === true;

    // 4) Suscribir nuestra app a la cuenta de WhatsApp (sin esto no llegan los avisos)
    await graph('POST', `${wabaId}/subscribed_apps`, { cfg, token });

    // 5) Coexistencia: pedir contactos e historial (solo una vez, dentro de 24 h)
    //    Número nuevo: registrarlo con un PIN de verificación en dos pasos
    const avisos = [];
    let historial = 'no_aplica';
    let pin = null;
    if (coexistencia) {
      historial = 'en_proceso';
      for (const tipo of ['smb_app_state_sync', 'history']) {
        try {
          await graph('POST', `${phoneId}/smb_app_data`, { cfg, token, body: { messaging_product: 'whatsapp', sync_type: tipo } });
        } catch (e) {
          avisos.push(`No se pudo pedir ${tipo === 'history' ? 'el historial' : 'los contactos'}: ${e.message}`);
          if (tipo === 'history') historial = 'pendiente';
        }
      }
    } else {
      pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      try {
        await graph('POST', `${phoneId}/register`, { cfg, token, body: { messaging_product: 'whatsapp', pin } });
      } catch (e) {
        pin = null;
        avisos.push('No se pudo registrar el número: ' + e.message);
      }
    }

    // 6) Guardar
    await masterQuery(
      `UPDATE wa_meta_cuentas SET
         estado='conectado', business_id=?, waba_id=?, phone_number_id=?,
         numero_display=?, nombre_verificado=?, access_token=?, token_expira=NULL,
         coexistencia=?, historial_sync=?, calidad=?, webhook_ok=1,
         conectado_at=NOW(), ultimo_error=?
       WHERE tenant_id=?`,
      [bizId, wabaId, phoneId, info.display_phone_number || null, info.verified_name || null,
       encrypt(token), coexistencia ? 1 : 0, historial, info.quality_rating || null,
       avisos.length ? avisos.join(' | ') : null, tenantId]
    );
    logger.info(`[wa-meta] Clínica ${tenantId} conectada a Meta: ${info.display_phone_number} (coexistencia=${coexistencia})`);

    const [cuenta] = await masterQuery('SELECT * FROM wa_meta_cuentas WHERE tenant_id = ?', [tenantId]);
    return res.json({
      success: true,
      message: 'WhatsApp conectado con Meta.',
      data   : { ...vistaCuenta(cuenta), avisos, pin },
    });
  } catch (err) {
    logger.error(`[wa-meta] Error conectando clínica ${tenantId}: ${err.message}`);
    await masterQuery(
      `UPDATE wa_meta_cuentas SET estado='error', ultimo_error=? WHERE tenant_id=? AND estado <> 'conectado'`,
      [String(err.message).slice(0, 1000), tenantId]
    ).catch(() => {});
    if (err.status && err.status < 500) return res.status(err.status).json({ success: false, message: err.message });
    if (err.status === 502) return res.status(502).json({ success: false, message: err.message });
    next(err);
  }
});

// ── POST /desconectar ───────────────────────────────────────────────
router.post('/desconectar', async (req, res, next) => {
  try {
    const tenantId = await tenantIdDe(req);
    const [c] = await masterQuery('SELECT * FROM wa_meta_cuentas WHERE tenant_id = ?', [tenantId]);
    if (!c || c.estado === 'desconectado') return res.json({ success: true, message: 'Ya estaba desconectado.' });

    // Quitar la suscripción en Meta (si falla, igual se desconecta en el sistema)
    if (c.waba_id && c.access_token) {
      try {
        const cfg = await configPlataforma();
        await graph('DELETE', `${c.waba_id}/subscribed_apps`, { cfg, token: decrypt(c.access_token) });
      } catch (e) { logger.warn(`[wa-meta] No se pudo quitar la suscripción de ${tenantId}: ${e.message}`); }
    }

    await masterQuery(
      `UPDATE wa_meta_cuentas SET estado='desconectado', access_token=NULL, phone_number_id=NULL,
         ultimo_error=NULL WHERE tenant_id=?`, [tenantId]
    );
    return res.json({ success: true, message: 'WhatsApp Meta desconectado.' });
  } catch (err) { next(err); }
});

module.exports = router;