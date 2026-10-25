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
        avisos.push('No se pudo registrar el número (si es el número de prueba de Meta, puedes ignorar este aviso: ya viene registrado). Detalle: ' + e.message);
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

// ── POST /diagnostico — vuelve a leer el número desde Meta y corrige lo guardado ──
//    · detecta si es coexistencia (número también en la app WhatsApp Business del celular)
//    · revisa que nuestra app siga suscrita a la cuenta (webhooks) y si no, la suscribe
router.post('/diagnostico', async (req, res, next) => {
  try {
    const { tenantId, cfg, token, wabaId, phoneId } = await cuentaConectada(req);
    const avisos = [];

    // Datos del número (si Meta no acepta algún campo, se piden los básicos)
    let info;
    try {
      info = await graph('GET', phoneId, {
        cfg, token,
        query: { fields: 'display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type,status,name_status,code_verification_status' },
      });
    } catch {
      info = await graph('GET', phoneId, {
        cfg, token, query: { fields: 'display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type' },
      });
    }

    // Suscripción de la app a la cuenta de WhatsApp
    let suscrito = false;
    try {
      const subs = await graph('GET', `${wabaId}/subscribed_apps`, { cfg, token });
      suscrito = (subs.data || []).some(s => String(s.whatsapp_business_api_data?.id || s.id || '') === String(cfg.appId));
      if (!suscrito) {
        await graph('POST', `${wabaId}/subscribed_apps`, { cfg, token });
        suscrito = true;
        avisos.push('La app no estaba suscrita a tu cuenta de WhatsApp; se volvió a suscribir.');
      }
    } catch (e) { avisos.push('No se pudo revisar la suscripción de avisos: ' + e.message); }

    const [c] = await masterQuery('SELECT coexistencia, historial_sync FROM wa_meta_cuentas WHERE tenant_id = ?', [tenantId]);
    const coexistencia = info.is_on_biz_app === true || !!Number(c?.coexistencia);
    let historial = c?.historial_sync || 'no_aplica';

    // Recién detectada como coexistencia: pedir contactos e historial (Meta solo lo permite en las primeras 24 h)
    if (coexistencia && !Number(c?.coexistencia)) {
      historial = 'en_proceso';
      for (const tipo of ['smb_app_state_sync', 'history']) {
        try {
          await graph('POST', `${phoneId}/smb_app_data`, { cfg, token, body: { messaging_product: 'whatsapp', sync_type: tipo } });
        } catch (e) {
          if (tipo === 'history') historial = 'pendiente';
          avisos.push(`No se pudo pedir ${tipo === 'history' ? 'el historial' : 'los contactos'} (Meta solo lo permite en las primeras 24 h): ${e.message}`);
        }
      }
    }

    await masterQuery(
      `UPDATE wa_meta_cuentas SET numero_display = COALESCE(?, numero_display), nombre_verificado = COALESCE(?, nombre_verificado),
         calidad = ?, coexistencia = ?, historial_sync = ?, webhook_ok = ?,
         ultimo_error = IF(? = 1, NULL, ultimo_error)
       WHERE tenant_id = ?`,
      [info.display_phone_number || null, info.verified_name || null, info.quality_rating || null,
       coexistencia ? 1 : 0, historial, suscrito ? 1 : 0, coexistencia ? 1 : 0, tenantId]
    );
    logger.info(`[wa-meta] Diagnóstico clínica ${tenantId}: ${JSON.stringify(info)} suscrito=${suscrito}`);

    return res.json({
      success: true,
      data: {
        numero        : info.display_phone_number || null,
        nombre        : info.verified_name || null,
        coexistencia,
        en_app_business: info.is_on_biz_app ?? null,
        plataforma    : info.platform_type || null,
        estado_numero : info.status || null,
        estado_nombre : info.name_status || null,
        verificacion  : info.code_verification_status || null,
        calidad       : info.quality_rating || null,
        suscrito,
        avisos,
      },
    });
  } catch (err) { responderError(res, next, err); }
});

// ── POST /registrar — registra el número en la API de Meta (error 133010 "Account not registered") ──
//    body: { pin? }  → si el número ya tenía PIN de verificación en dos pasos, se usa ese;
//                     si no, se crea uno nuevo y se devuelve para que la clínica lo guarde.
router.post('/registrar', async (req, res, next) => {
  try {
    const { tenantId, cfg, token, phoneId } = await cuentaConectada(req);
    const pinDado = String(req.body?.pin || '').trim();
    if (pinDado && !/^\d{6}$/.test(pinDado)) {
      return res.status(422).json({ success: false, message: 'El PIN debe tener 6 dígitos.' });
    }
    const pin = pinDado || String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    try {
      await graph('POST', `${phoneId}/register`, { cfg, token, body: { messaging_product: 'whatsapp', pin } });
    } catch (e) {
      logger.warn(`[wa-meta] Registro del número falló (clínica ${tenantId}): ${e.message} ${JSON.stringify(e.meta || {})}`);
      const det = e.meta ? ` (código ${e.meta.code}${e.meta.error_subcode ? '/' + e.meta.error_subcode : ''})` : '';
      let ayuda = '';
      if (/policy|polic/i.test(e.message)) {
        ayuda = ' Revisa en el Administrador de WhatsApp (business.facebook.com → WhatsApp Manager) que la cuenta tenga un método de pago, que el nombre visible esté aprobado y que la cuenta no tenga restricciones.';
      } else if (/pin|two.?step|verificaci/i.test(e.message)) {
        ayuda = ' Ese número ya tiene un PIN de verificación en dos pasos: escríbelo en el campo PIN y vuelve a intentar.';
      }
      return res.status(422).json({ success: false, message: 'Meta no registró el número: ' + e.message + det + '.' + ayuda });
    }
    await masterQuery('UPDATE wa_meta_cuentas SET ultimo_error = NULL WHERE tenant_id = ?', [tenantId]);
    logger.info(`[wa-meta] Número registrado en Meta (clínica ${tenantId})`);
    return res.json({ success: true, message: 'Número registrado en Meta.', data: { pin: pinDado ? null : pin } });
  } catch (err) { responderError(res, next, err); }
});

// ════════════════════════════════════════════════════════════════════
//  PLANTILLAS Y ENVÍO (requieren la clínica conectada)
// ════════════════════════════════════════════════════════════════════

// Datos para llamar a Meta en nombre de la clínica
async function cuentaConectada(req) {
  const tenantId = await tenantIdDe(req);
  const [c] = await masterQuery('SELECT * FROM wa_meta_cuentas WHERE tenant_id = ?', [tenantId]);
  if (!c || c.estado !== 'conectado' || !c.access_token || !c.waba_id || !c.phone_number_id) {
    const e = new Error('Primero conecta tu número con Meta.'); e.status = 409; throw e;
  }
  const cfg = await configPlataforma();
  let token;
  try { token = decrypt(c.access_token); }
  catch { const e = new Error('No se pudo leer el token guardado. Vuelve a conectar tu número.'); e.status = 409; throw e; }
  return { tenantId, cfg, token, wabaId: c.waba_id, phoneId: c.phone_number_id };
}

function responderError(res, next, err) {
  if (err.status && err.status < 500) return res.status(err.status).json({ success: false, message: err.message });
  if (err.status === 502) return res.status(502).json({ success: false, message: err.message });
  return next(err);
}

// Variables {{1}}, {{2}}… usadas en un texto
function variablesDe(texto) {
  return [...String(texto).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(m => parseInt(m[1], 10));
}

/**
 * Revisa la plantilla con las reglas que más rechaza Meta.
 * Devuelve la lista de problemas (vacía = OK).
 */
function validarPlantilla({ nombre, categoria, cuerpo, ejemplos, pie, encabezado }) {
  const p = [];
  if (!/^[a-z0-9_]{1,512}$/.test(nombre || '')) p.push('El nombre solo puede tener minúsculas, números y guion bajo (ej. recordatorio_vacuna).');
  if (!['UTILITY', 'MARKETING'].includes(categoria)) p.push('Elige la categoría: Utilidad o Marketing.');
  const txt = String(cuerpo || '').trim();
  if (!txt) p.push('Escribe el texto del mensaje.');
  if (txt.length > 1024) p.push('El mensaje no puede pasar de 1024 caracteres.');

  const vars = variablesDe(txt);
  const unicas = [...new Set(vars)].sort((a, b) => a - b);
  unicas.forEach((n, i) => { if (n !== i + 1) p.push('Las variables deben ir en orden: {{1}}, {{2}}, {{3}}…'); });
  if (/^\{\{\s*\d+\s*\}\}/.test(txt)) p.push('El mensaje no puede empezar con una variable.');
  if (/\{\{\s*\d+\s*\}\}[\s.!?¡¿]*$/.test(txt)) p.push('El mensaje no puede terminar con una variable (agrega texto después).');
  if (/\{\{\s*\d+\s*\}\}\s*\{\{\s*\d+\s*\}\}/.test(txt)) p.push('No pongas dos variables seguidas: escribe texto entre ellas.');
  const palabras = txt.replace(/\{\{\s*\d+\s*\}\}/g, ' ').split(/\s+/).filter(Boolean).length;
  if (unicas.length && palabras < unicas.length * 2 + 1) p.push('Hay demasiadas variables para tan poco texto.');
  if ((ejemplos || []).length < unicas.length || (ejemplos || []).slice(0, unicas.length).some(e => !String(e || '').trim())) {
    p.push('Escribe un ejemplo para cada variable (Meta lo exige).');
  }
  if (pie && String(pie).length > 60) p.push('El pie de mensaje no puede pasar de 60 caracteres.');
  if (encabezado && String(encabezado).length > 60) p.push('El encabezado no puede pasar de 60 caracteres.');
  if (encabezado && variablesDe(encabezado).length) p.push('El encabezado no puede tener variables.');
  return [...new Set(p)];
}

// ── Plantillas guardadas en la base de la clínica (wa_meta_plantillas, migración v18) ──
const ESTADO_DESDE_META = {
  APPROVED: 'aprobada', PENDING: 'pendiente', IN_APPEAL: 'pendiente', REJECTED: 'rechazada',
  PAUSED: 'pausada', DISABLED: 'deshabilitada', FLAGGED: 'pausada', LIMIT_EXCEEDED: 'deshabilitada',
  PENDING_DELETION: 'deshabilitada', DELETED: 'deshabilitada',
};

function errorSinMigracion(e) {
  return e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR' || /doesn't exist|Unknown column/i.test(e.message || ''));
}
function faltaMigracion() {
  const e = new Error('Falta actualizar la base de datos de la clínica (migración v18). Avisa a soporte.');
  e.status = 409; return e;
}

async function plantillasMeta(cfg, token, wabaId, nombre) {
  const query = { fields: 'id,name,language,status,category,components,rejected_reason', limit: '200' };
  if (nombre) query.name = nombre;
  const d = await graph('GET', `${wabaId}/message_templates`, { cfg, token, query });
  return d.data || [];
}

function vistaPlantillaMeta(t) {
  const body   = (t.components || []).find(c => c.type === 'BODY');
  const header = (t.components || []).find(c => c.type === 'HEADER' && c.format === 'TEXT');
  const footer = (t.components || []).find(c => c.type === 'FOOTER');
  return {
    id: t.id, nombre: t.name, idioma: t.language, estado: t.status, categoria: t.category,
    cuerpo: body?.text || '', encabezado: header?.text || '', pie: footer?.text || '',
    encabezado_formato: (t.components || []).find(c => c.type === 'HEADER')?.format || null,   // TEXT | IMAGE | VIDEO | DOCUMENT
    variables: [...new Set(variablesDe(body?.text || ''))].length,
    motivo_rechazo: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
  };
}

// Copia el estado que tiene Meta en wa_meta_plantillas (aprobada, rechazada…)
async function sincronizarPlantillas(req, lista) {
  try {
    const filas = await req.db.query('SELECT id, nombre_meta, idioma, meta_template_id FROM wa_meta_plantillas');
    for (const f of filas) {
      const t = lista.find(x => x.name === f.nombre_meta && x.language === f.idioma);
      if (t) {
        await req.db.query(
          `UPDATE wa_meta_plantillas SET estado=?, categoria=?, motivo_rechazo=?, meta_template_id=?, activo=1 WHERE id=?`,
          [ESTADO_DESDE_META[t.status] || 'pendiente',
           ['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(t.category) ? t.category : 'UTILITY',
           t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null, t.id, f.id]
        );
      } else if (f.meta_template_id) {
        // Ya no existe en Meta (la borraron desde Meta o desde aquí)
        await req.db.query(`UPDATE wa_meta_plantillas SET estado='deshabilitada', activo=0 WHERE id=?`, [f.id]);
      }
    }
    return true;
  } catch (e) {
    if (!errorSinMigracion(e)) logger.warn('[wa-meta] No se pudo sincronizar plantillas: ' + e.message);
    return false;
  }
}

// ── GET /plantillas — lista las plantillas de la clínica en Meta ─────
router.get('/plantillas', async (req, res, next) => {
  try {
    const { cfg, token, wabaId } = await cuentaConectada(req);
    const lista = await plantillasMeta(cfg, token, wabaId);
    await sincronizarPlantillas(req, lista);
    let usos = [];
    try { usos = await req.db.query('SELECT nombre_meta, idioma, uso, es_estandar, variables FROM wa_meta_plantillas WHERE activo=1'); }
    catch { /* sin migración v18 */ }
    const data = lista.map(t => {
      const u = usos.find(x => x.nombre_meta === t.name && x.idioma === t.language);
      const v = vistaPlantillaMeta(t);
      // Nombre de cada variable ({{1}} = nombre, {{2}} = mascota…) si la plantilla se creó desde el sistema
      let nombres = null;
      try { nombres = u?.variables ? JSON.parse(u.variables) : null; } catch { nombres = null; }
      if (!Array.isArray(nombres) || nombres.length !== v.variables) nombres = null;
      return { ...v, uso: u?.uso || null, es_estandar: !!(u && Number(u.es_estandar)), variables_nombres: nombres };
    });
    return res.json({ success: true, data });
  } catch (err) { responderError(res, next, err); }
});

// Arma los componentes de Meta (encabezado, cuerpo con ejemplos, pie)
function componentesPlantilla({ encabezado, cuerpo, pie, ejemplos, imagenHandle }) {
  const nVars = [...new Set(variablesDe(cuerpo))].length;
  const components = [];
  if (imagenHandle) components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [imagenHandle] } });
  else if (encabezado) components.push({ type: 'HEADER', format: 'TEXT', text: encabezado });
  const body = { type: 'BODY', text: cuerpo };
  if (nVars) body.example = { body_text: [ejemplos.slice(0, nVars)] };
  components.push(body);
  if (pie) components.push({ type: 'FOOTER', text: pie });
  return components;
}

// ── Datos con nombre: [nombre], [mascota]… → {{1}}, {{2}}… ──────────────
// Devuelve { cuerpo, nombres } — nombres = null si el texto ya venía con {{1}}
function convertirEtiquetas(texto) {
  const t = String(texto || '');
  if (!/\[[a-z0-9_]{1,30}\]/i.test(t)) return { cuerpo: t, nombres: null };
  if (/\{\{\s*\d+\s*\}\}/.test(t)) {
    const e = new Error('Usa los botones de datos ([nombre], [mascota]…) en lugar de {{1}}, {{2}}.'); e.status = 422; throw e;
  }
  const nombres = [];
  const cuerpo = t.replace(/\[([a-z0-9_]{1,30})\]/gi, (_, k) => {
    k = k.toLowerCase();
    let i = nombres.indexOf(k);
    if (i === -1) { nombres.push(k); i = nombres.length - 1; }
    return `{{${i + 1}}}`;
  });
  return { cuerpo, nombres };
}

// ── Imágenes ─────────────────────────────────────────────────────────
const MIME_IMAGEN = ['image/jpeg', 'image/png'];
const MAX_IMAGEN  = 5 * 1024 * 1024;   // límite de Meta para imágenes

function leerImagen(img) {
  if (!img || !img.base64) return null;
  const mime = String(img.mime || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!MIME_IMAGEN.includes(mime)) { const e = new Error('La imagen debe ser JPG o PNG.'); e.status = 422; throw e; }
  const buf = Buffer.from(String(img.base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!buf.length) { const e = new Error('La imagen está vacía.'); e.status = 422; throw e; }
  if (buf.length > MAX_IMAGEN) { const e = new Error('La imagen no puede pasar de 5 MB.'); e.status = 422; throw e; }
  const ext  = mime === 'image/png' ? 'png' : 'jpg';
  const nombre = (String(img.nombre || 'imagen').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40) || 'imagen') + '.' + ext;
  return { buf, mime, nombre };
}

async function respuestaMeta(r, quePaso) {
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) {
    const e = new Error(`${quePaso}: ${d.error?.error_user_msg || d.error?.message || 'Meta respondió ' + r.status}`);
    e.status = 422; e.meta = d.error; throw e;
  }
  return d;
}

// Imagen de ejemplo para crear la plantilla (Resumable Upload → "header_handle")
async function subirImagenEjemplo(cfg, token, img) {
  const base = `${GRAPH_BASE}/${cfg.graphVer}`;
  const q = new URLSearchParams({ file_name: img.nombre, file_length: String(img.buf.length), file_type: img.mime, access_token: token });
  let r = await fetch(`${base}/${cfg.appId}/uploads?${q}`, { method: 'POST', signal: AbortSignal.timeout(20000) });
  const sesion = await respuestaMeta(r, 'No se pudo preparar la subida de la imagen');
  r = await fetch(`${base}/${sesion.id}`, {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `OAuth ${token}`, file_offset: '0', 'Content-Type': img.mime },
    body: img.buf,
  });
  const d = await respuestaMeta(r, 'No se pudo subir la imagen a Meta');
  if (!d.h) { const e = new Error('Meta no devolvió el identificador de la imagen.'); e.status = 422; throw e; }
  return d.h;
}

// Imagen para enviar en un mensaje (queda en Meta 30 días) → media id
async function subirImagenEnvio(cfg, token, phoneId, img) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', img.mime);
  form.append('file', new Blob([img.buf], { type: img.mime }), img.nombre);
  const r = await fetch(`${GRAPH_BASE}/${cfg.graphVer}/${phoneId}/media`, {
    method: 'POST', signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  const d = await respuestaMeta(r, 'No se pudo subir la imagen a Meta');
  return d.id;
}

// ── Copia en Azure Blob Storage (mismo contenedor que las campañas por QR) ──
let _azureWa = null;
function contenedorWA() {
  const conn = process.env.AZURE_WA_STORAGE_CONNECTION || process.env.AZURE_STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) return null;
  if (!_azureWa) {
    const { BlobServiceClient } = require('@azure/storage-blob');
    _azureWa = BlobServiceClient.fromConnectionString(conn);
  }
  return _azureWa.getContainerClient(process.env.AZURE_WA_CONTAINER || 'wa-media');
}

async function guardarEnBlob(tenantId, img) {
  const cont = contenedorWA();
  if (!cont) { logger.warn('[wa-meta] Azure Blob no configurado: la imagen solo queda en Meta'); return null; }
  const nombre = `meta/${tenantId}/${Date.now()}-${img.nombre}`;
  await cont.getBlockBlobClient(nombre).upload(img.buf, img.buf.length, { blobHTTPHeaders: { blobContentType: img.mime } });
  return nombre;
}

async function borrarDeBlob(nombre) {
  const cont = contenedorWA();
  if (!cont || !nombre) return;
  try { await cont.deleteBlob(nombre); } catch (e) { logger.warn('[wa-meta] No se pudo borrar el blob ' + nombre + ': ' + e.message); }
}

// ── POST /media — sube una imagen para enviarla (envío manual o campaña) ──
//    body: { imagen: { base64, mime, nombre }, guardar?: true }  →  { id, blob }
//    guardar = true (campañas): además queda una copia en Azure Blob Storage
router.post('/media', async (req, res, next) => {
  try {
    const img = leerImagen(req.body?.imagen);
    if (!img) return res.status(422).json({ success: false, message: 'Elige una imagen.' });
    const { tenantId, cfg, token, phoneId } = await cuentaConectada(req);
    const id = await subirImagenEnvio(cfg, token, phoneId, img);
    let blob = null;
    if (req.body?.guardar) {
      try { blob = await guardarEnBlob(tenantId, img); }
      catch (e) { logger.warn('[wa-meta] No se pudo guardar la imagen en Azure: ' + e.message); }
    }
    return res.json({ success: true, data: { id, blob } });
  } catch (err) { responderError(res, next, err); }
});

// ── POST /plantillas — crea una plantilla y la envía a revisión ──────
router.post('/plantillas', async (req, res, next) => {
  try {
    const b = req.body || {};
    const conv = convertirEtiquetas(String(b.cuerpo || '').trim());
    const tipoEnc = ['texto', 'imagen'].includes(b.encabezado_tipo) ? b.encabezado_tipo : (b.encabezado ? 'texto' : 'ninguno');
    const datos = {
      nombre    : String(b.nombre || '').trim().toLowerCase(),
      categoria : String(b.categoria || '').toUpperCase(),
      idioma    : String(b.idioma || 'es').trim(),
      encabezado: tipoEnc === 'texto' ? String(b.encabezado || '').trim() : '',
      cuerpo    : conv.cuerpo.trim(),
      pie       : String(b.pie || '').trim(),
      ejemplos  : Array.isArray(b.ejemplos) ? b.ejemplos.map(e => String(e || '').trim()) : [],
    };
    const problemas = validarPlantilla(datos);
    const img = tipoEnc === 'imagen' ? leerImagen(b.imagen) : null;
    if (tipoEnc === 'imagen' && !img) problemas.unshift('Elige la imagen de ejemplo del encabezado.');
    if (problemas.length) return res.status(422).json({ success: false, message: problemas[0], problemas });

    const { cfg, token, wabaId } = await cuentaConectada(req);
    if (img) datos.imagenHandle = await subirImagenEjemplo(cfg, token, img);
    const d = await graph('POST', `${wabaId}/message_templates`, {
      cfg, token,
      body: { name: datos.nombre, language: datos.idioma, category: datos.categoria, components: componentesPlantilla(datos) },
    });

    // Se guarda también en la base de la clínica (para campañas y estados)
    try {
      await req.db.query(
        `INSERT INTO wa_meta_plantillas (nombre_meta, idioma, categoria, uso, encabezado_tipo, encabezado_texto, cuerpo, variables, pie,
           meta_template_id, estado, es_estandar, activo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,0,1)
         ON DUPLICATE KEY UPDATE categoria=VALUES(categoria), cuerpo=VALUES(cuerpo), variables=VALUES(variables),
           encabezado_tipo=VALUES(encabezado_tipo), encabezado_texto=VALUES(encabezado_texto), pie=VALUES(pie),
           meta_template_id=VALUES(meta_template_id), estado=VALUES(estado), activo=1`,
        [datos.nombre, datos.idioma, datos.categoria, datos.categoria === 'MARKETING' ? 'campana' : 'manual',
         tipoEnc, datos.encabezado || null, datos.cuerpo, conv.nombres ? JSON.stringify(conv.nombres) : null, datos.pie || null,
         d.id || null, ESTADO_DESDE_META[d.status] || 'pendiente']
      );
    } catch (e) { if (!errorSinMigracion(e)) logger.warn('[wa-meta] No se guardó la plantilla en la clínica: ' + e.message); }

    return res.status(201).json({
      success: true,
      message: 'Plantilla enviada a revisión de Meta.',
      data: { id: d.id, estado: d.status || 'PENDING', categoria: d.category || datos.categoria },
    });
  } catch (err) { responderError(res, next, err); }
});

// ── DELETE /plantillas/:nombre ───────────────────────────────────────
router.delete('/plantillas/:nombre', async (req, res, next) => {
  try {
    const nombre = String(req.params.nombre || '');
    if (!/^[a-z0-9_]{1,512}$/.test(nombre)) return res.status(422).json({ success: false, message: 'Nombre inválido.' });
    const { cfg, token, wabaId } = await cuentaConectada(req);
    await graph('DELETE', `${wabaId}/message_templates`, { cfg, token, query: { name: nombre } });
    try { await req.db.query(`UPDATE wa_meta_plantillas SET estado='deshabilitada', activo=0 WHERE nombre_meta=?`, [nombre]); }
    catch { /* sin migración v18 */ }
    return res.json({ success: true, message: 'Plantilla eliminada.' });
  } catch (err) { responderError(res, next, err); }
});

// Número en formato internacional sin "+" (ej. 51987654321)
async function normalizarTelefono(req, tel) {
  let t = String(tel || '').replace(/\D/g, '');
  if (!t) return null;
  if (t.length === 9) {   // número local peruano → agregar código de país de la clínica
    let cod = '51';
    try {
      const [cfg] = await req.db.query('SELECT codigo_pais FROM wa_config LIMIT 1');
      if (cfg?.codigo_pais) cod = String(cfg.codigo_pais).replace(/\D/g, '') || '51';
    } catch { /* sin wa_config: Perú */ }
    t = cod + t;
  }
  return t.length >= 10 && t.length <= 15 ? t : null;
}

// Registro en el historial de mensajes de la clínica (si falta la migración v18, sin columnas nuevas)
async function registrarEnvio(req, { telefono, mensaje, estado, error, wamid, propietarioId }) {
  try {
    await req.db.query(
      `INSERT INTO wa_mensajes_log (tipo, propietario_id, telefono, mensaje, estado, error, enviado_at, proveedor, wamid)
       VALUES ('manual', ?, ?, ?, ?, ?, ${estado === 'enviado' ? 'NOW()' : 'NULL'}, 'meta', ?)`,
      [propietarioId || null, telefono, mensaje, estado, error || null, wamid || null]
    );
  } catch {
    try {
      await req.db.query(
        `INSERT INTO wa_mensajes_log (tipo, propietario_id, telefono, mensaje, estado, error, enviado_at)
         VALUES ('manual', ?, ?, ?, ?, ?, ${estado === 'enviado' ? 'NOW()' : 'NULL'})`,
        [propietarioId || null, telefono, mensaje, estado, error || null]
      );
    } catch (e) { logger.warn('[wa-meta] No se pudo registrar el envío: ' + e.message); }
  }
}

// ── POST /enviar — envía una plantilla (o texto, si el cliente escribió en las últimas 24 h) ──
router.post('/enviar', async (req, res, next) => {
  let telefono = null, resumen = '';
  try {
    const b = req.body || {};
    telefono = await normalizarTelefono(req, b.telefono);
    if (!telefono) return res.status(422).json({ success: false, message: 'Número de teléfono inválido.' });

    const tipo = b.tipo === 'texto' ? 'texto' : 'plantilla';
    const { cfg, token, phoneId } = await cuentaConectada(req);
    let payload;

    if (tipo === 'texto') {
      const texto = String(b.texto || '').trim();
      if (!texto) return res.status(422).json({ success: false, message: 'Escribe el mensaje.' });
      if (texto.length > 4096) return res.status(422).json({ success: false, message: 'El mensaje es demasiado largo.' });
      payload = { messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: texto } };
      resumen = texto;
    } else {
      const nombre = String(b.plantilla || '').trim();
      if (!/^[a-z0-9_]{1,512}$/.test(nombre)) return res.status(422).json({ success: false, message: 'Elige una plantilla aprobada.' });
      // Meta no acepta saltos de línea, tabulaciones ni más de 4 espacios seguidos en las variables
      const vars = Array.isArray(b.variables) ? b.variables.map(v => String(v ?? '').replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim()) : [];
      if (vars.some(v => !v)) return res.status(422).json({ success: false, message: 'Completa todas las variables de la plantilla.' });
      payload = {
        messaging_product: 'whatsapp', to: telefono, type: 'template',
        template: { name: nombre, language: { code: String(b.idioma || 'es') } },
      };
      const comps = [];
      // Plantilla con imagen en el encabezado: la imagen se sube antes con POST /media
      const mediaId = String(b.imagen_media_id || '').trim();
      if (mediaId) {
        if (!/^\d{5,30}$/.test(mediaId)) return res.status(422).json({ success: false, message: 'Imagen inválida: vuelve a elegirla.' });
        comps.push({ type: 'header', parameters: [{ type: 'image', image: { id: mediaId } }] });
      }
      if (vars.length) comps.push({ type: 'body', parameters: vars.map(v => ({ type: 'text', text: v })) });
      if (comps.length) payload.template.components = comps;
      resumen = String(b.vista_previa || `[plantilla ${nombre}] ${vars.join(' | ')}`).slice(0, 2000);
    }

    const d = await graph('POST', `${phoneId}/messages`, { cfg, token, body: payload });
    const wamid = d.messages?.[0]?.id || null;
    await registrarEnvio(req, { telefono, mensaje: resumen, estado: 'enviado', wamid, propietarioId: b.propietario_id });
    return res.json({ success: true, message: 'Mensaje enviado.', data: { wamid, telefono } });
  } catch (err) {
    if (telefono && err.status && err.status !== 409) {
      await registrarEnvio(req, { telefono, mensaje: resumen || '[meta]', estado: 'fallido', error: err.message });
    }
    // 131047: fuera de la ventana de 24 h → solo plantillas
    if (err.meta?.code === 131047) {
      return res.status(422).json({ success: false, message: 'Este cliente no te escribió en las últimas 24 horas: solo puedes enviarle una plantilla aprobada.' });
    }
    // 131030: número de prueba de Meta → solo a destinatarios autorizados
    if (err.meta?.code === 131030) {
      return res.status(422).json({ success: false, message: 'Con el número de prueba de Meta solo puedes enviar a los números que agregaste como destinatarios en Meta (WhatsApp → Configuración de la API → "Para").' });
    }
    // 133010: el número está conectado pero no registrado en la API
    if (err.meta?.code === 133010) {
      return res.status(422).json({ success: false, codigo: 133010, message: 'Meta dice que tu número no está activo en la API («Account not registered»). Ve a la pestaña «Conexión» y pulsa «Revisar número con Meta».' });
    }
    // 132012: falta un parámetro (por ejemplo la imagen del encabezado)
    if (err.meta?.code === 132012) {
      return res.status(422).json({ success: false, message: 'A la plantilla le falta un dato: si tiene imagen, elígela antes de enviar.' });
    }
    // 132001: la plantilla no existe en ese idioma o aún no está aprobada
    if (err.meta?.code === 132001) {
      return res.status(422).json({ success: false, message: 'La plantilla no existe o todavía no está aprobada por Meta.' });
    }
    responderError(res, next, err);
  }
});

// ════════════════════════════════════════════════════════════════════
//  PLANTILLAS DE RECORDATORIOS (las mismas que usa la clínica con QR)
//  Cada recordatorio del sistema tiene su plantilla en Meta, creada a partir
//  del texto que la clínica ya tiene en wa_plantillas ([nombre], [mascota]…).
// ════════════════════════════════════════════════════════════════════

const USOS_SISTEMA = [
  { uso: 'recordatorio_cita', titulo: 'Recordatorio de cita médica', datos: ['nombre', 'mascota', 'fecha', 'hora'],
    estandar: '🐾 Hola [nombre], te recordamos que tienes una cita médica para *[mascota]* el *[fecha]* a las *[hora]* en *[clinica]*. Si no puedes asistir, responde este mensaje para reprogramarla.' },
  { uso: 'recordatorio_cita_vacuna', titulo: 'Recordatorio de cita de vacunación', datos: ['nombre', 'mascota', 'fecha', 'hora'],
    estandar: '💉 Hola [nombre], te recordamos que *[mascota]* tiene su cita de vacunación el *[fecha]* a las *[hora]* en *[clinica]*. Si no puedes asistir, responde este mensaje para reprogramarla.' },
  { uso: 'recordatorio_cita_desparasitacion', titulo: 'Recordatorio de cita de desparasitación', datos: ['nombre', 'mascota', 'fecha', 'hora'],
    estandar: '🐛 Hola [nombre], te recordamos que *[mascota]* tiene su cita de desparasitación el *[fecha]* a las *[hora]* en *[clinica]*. Si no puedes asistir, responde este mensaje para reprogramarla.' },
  { uso: 'recordatorio_cita_estetica', titulo: 'Recordatorio de cita de estética', datos: ['nombre', 'mascota', 'fecha', 'hora'],
    estandar: '✂️ Hola [nombre], te recordamos que *[mascota]* tiene su cita de estética el *[fecha]* a las *[hora]* en *[clinica]*. Si no puedes asistir, responde este mensaje para reprogramarla.' },
  { uso: 'recordatorio_vacuna', titulo: 'Aviso de vacuna pendiente', datos: ['nombre', 'mascota', 'vacuna', 'fecha'],
    estandar: '💉 Hola [nombre], te recordamos que *[mascota]* tiene pendiente su vacuna *[vacuna]* para el *[fecha]*. Responde este mensaje para coordinar su cita en *[clinica]*.' },
  { uso: 'recordatorio_desparasitacion', titulo: 'Aviso de desparasitación pendiente', datos: ['nombre', 'mascota', 'producto', 'fecha'],
    estandar: '🐛 Hola [nombre], te recordamos que *[mascota]* tiene pendiente su desparasitación con *[producto]* para el *[fecha]*. Responde este mensaje para coordinar en *[clinica]*.' },
];
const ETIQUETA_DATO = { nombre: 'Nombre del cliente', mascota: 'Mascota', fecha: 'Fecha', hora: 'Hora', vacuna: 'Vacuna', producto: 'Producto' };
const EJEMPLO_DATO  = { nombre: 'María López', mascota: 'Firulais', fecha: '25 de octubre de 2026', hora: '10:30 a. m.', vacuna: 'Rabia', producto: 'Bravecto' };
const NOMBRE_META_DE = uso => `vet_${uso}`;

async function datosClinica(tenantId) {
  const [c] = await masterQuery('SELECT nombre_clinica, telefono FROM tenant_config WHERE tenant_id = ? LIMIT 1', [tenantId]);
  return { clinica: (c?.nombre_clinica || 'nuestra veterinaria').trim(), telefono: (c?.telefono || '').trim() };
}

/**
 * Convierte un texto con etiquetas [nombre], [mascota]… al formato de Meta.
 *  · [clinica] y [telefono] se escriben fijos (son siempre los mismos)
 *  · el resto pasa a {{1}}, {{2}}… en el orden en que aparecen
 * Devuelve { cuerpo, variables, ejemplos }.
 */
function convertirTexto(texto, datosPermitidos, clinica, telefono) {
  let t = String(texto || '').replace(/\r/g, '');
  t = t.replace(/\[clinica\]/gi, clinica);
  if (telefono) t = t.replace(/\[telefono\]/gi, telefono);
  else t = t.replace(/[^.!?¡\n]*\[telefono\][^.!?\n]*[.!?]?/gi, '');   // sin teléfono: se quita la frase
  const variables = [];
  t = t.replace(/\[([a-z_]+)\]/gi, (_, k) => {
    k = k.toLowerCase();
    if (!datosPermitidos.includes(k)) return '';
    let i = variables.indexOf(k);
    if (i === -1) { variables.push(k); i = variables.length - 1; }
    return `{{${i + 1}}}`;
  });
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  return { cuerpo: t, variables, ejemplos: variables.map(v => EJEMPLO_DATO[v] || 'Ejemplo') };
}

// Propuesta para un uso: el texto de la clínica, o el estándar si el suyo no pasaría la revisión
function propuestaPara(def, textoClinica, clinica, telefono) {
  if (textoClinica) {
    const c = convertirTexto(textoClinica, def.datos, clinica, telefono);
    const prob = validarPlantilla({ nombre: NOMBRE_META_DE(def.uso), categoria: 'UTILITY', cuerpo: c.cuerpo, ejemplos: c.ejemplos });
    if (!prob.length) return { ...c, origen: 'clinica' };
  }
  return { ...convertirTexto(def.estandar, def.datos, clinica, telefono), origen: 'estandar' };
}

// ── GET /plantillas-sistema — estado de las plantillas de recordatorios ──
router.get('/plantillas-sistema', async (req, res, next) => {
  try {
    const tenantId = await tenantIdDe(req);
    const { clinica, telefono } = await datosClinica(tenantId);

    let guardadas;
    try {
      guardadas = await req.db.query(
        `SELECT id, nombre_meta, idioma, uso, cuerpo, variables, estado, categoria, motivo_rechazo, meta_template_id, updated_at
         FROM wa_meta_plantillas WHERE es_estandar = 1 AND activo = 1 ORDER BY id DESC`
      );
    } catch (e) { if (errorSinMigracion(e)) throw faltaMigracion(); throw e; }

    let textos = [];
    try { textos = await req.db.query('SELECT tipo, contenido FROM wa_plantillas WHERE activo = 1 ORDER BY id DESC'); }
    catch { /* sin plantillas QR */ }

    const data = USOS_SISTEMA.map(def => {
      const propia = textos.find(x => x.tipo === def.uso);
      const prop   = propuestaPara(def, propia?.contenido, clinica, telefono);
      const g      = guardadas.find(x => x.uso === def.uso);
      let vars = [];
      try { vars = g?.variables ? JSON.parse(g.variables) : []; } catch { vars = []; }
      return {
        uso: def.uso, titulo: def.titulo,
        datos: def.datos.map(k => ({ clave: k, etiqueta: ETIQUETA_DATO[k] })),
        propuesta: { cuerpo: prop.cuerpo, variables: prop.variables, origen: prop.origen },
        meta: g ? {
          id: g.id, nombre: g.nombre_meta, cuerpo: g.cuerpo, variables: vars, estado: g.estado,
          categoria: g.categoria, motivo_rechazo: g.motivo_rechazo, actualizado: g.updated_at,
        } : null,
      };
    });
    return res.json({ success: true, data, clinica: { nombre: clinica, telefono } });
  } catch (err) { responderError(res, next, err); }
});

// Crea (o corrige y reenvía) la plantilla de un uso en Meta y la guarda en la clínica
async function enviarPlantillaSistema(req, ctx, def, textoEditado) {
  const { cfg, token, wabaId, clinica, telefono } = ctx;
  let prop;
  if (textoEditado) {
    prop = { ...convertirTexto(textoEditado, def.datos, clinica, telefono), origen: 'editado' };
  } else {
    let propia = null;
    try { [propia] = await req.db.query('SELECT contenido FROM wa_plantillas WHERE tipo = ? AND activo = 1 ORDER BY id DESC LIMIT 1', [def.uso]); }
    catch { /* sin plantillas QR */ }
    prop = propuestaPara(def, propia?.contenido, clinica, telefono);
  }
  const nombre = NOMBRE_META_DE(def.uso);
  const problemas = validarPlantilla({ nombre, categoria: 'UTILITY', cuerpo: prop.cuerpo, ejemplos: prop.ejemplos });
  if (problemas.length) return { uso: def.uso, ok: false, message: problemas[0] };

  const [g] = await req.db.query(
    'SELECT * FROM wa_meta_plantillas WHERE nombre_meta = ? AND idioma = ? LIMIT 1', [nombre, 'es']
  );
  if (g && g.activo && g.estado === 'aprobada' && g.cuerpo === prop.cuerpo) {
    return { uso: def.uso, ok: true, estado: 'aprobada', message: 'Ya estaba aprobada.' };
  }
  if (g && g.activo && g.estado === 'pendiente' && g.cuerpo === prop.cuerpo) {
    return { uso: def.uso, ok: true, estado: 'pendiente', message: 'Ya está en revisión.' };
  }

  const components = componentesPlantilla({ cuerpo: prop.cuerpo, ejemplos: prop.ejemplos });
  const editar = async (id) => {
    // Plantilla que ya existe en Meta → se corrige y Meta la vuelve a revisar
    await graph('POST', `${id}`, { cfg, token, body: { category: 'UTILITY', components } });
  };
  let templateId = g && g.activo && g.meta_template_id ? g.meta_template_id : null;
  let estadoMeta = 'PENDING';
  let categoria  = 'UTILITY';

  try {
    if (templateId) {
      await editar(templateId);
    } else {
      try {
        const d = await graph('POST', `${wabaId}/message_templates`, {
          cfg, token, body: { name: nombre, language: 'es', category: 'UTILITY', components },
        });
        templateId = d.id; estadoMeta = d.status || 'PENDING'; categoria = d.category || 'UTILITY';
      } catch (e) {
        // Ya existía en Meta con ese nombre (creada antes): se toma esa y se corrige si hace falta
        const existe = (await plantillasMeta(cfg, token, wabaId, nombre).catch(() => []))
          .find(x => x.name === nombre && x.language === 'es');
        if (!existe) throw e;
        templateId = existe.id;
        categoria  = existe.category || 'UTILITY';
        if (vistaPlantillaMeta(existe).cuerpo === prop.cuerpo) estadoMeta = existe.status || 'PENDING';
        else await editar(templateId);
      }
    }
  } catch (e) {
    return { uso: def.uso, ok: false, message: 'Meta no aceptó la plantilla: ' + e.message };
  }

  await req.db.query(
    `INSERT INTO wa_meta_plantillas (nombre_meta, idioma, categoria, uso, encabezado_tipo, cuerpo, variables,
       meta_template_id, estado, motivo_rechazo, es_estandar, activo)
     VALUES (?,?,?,?, 'ninguno', ?,?,?,?, NULL, 1, 1)
     ON DUPLICATE KEY UPDATE categoria=VALUES(categoria), uso=VALUES(uso), cuerpo=VALUES(cuerpo), variables=VALUES(variables),
       meta_template_id=VALUES(meta_template_id), estado=VALUES(estado), motivo_rechazo=NULL, es_estandar=1, activo=1`,
    [nombre, 'es', ['UTILITY', 'MARKETING'].includes(categoria) ? categoria : 'UTILITY', def.uso, prop.cuerpo,
     JSON.stringify(prop.variables), templateId, ESTADO_DESDE_META[estadoMeta] || 'pendiente']
  );
  return { uso: def.uso, ok: true, estado: ESTADO_DESDE_META[estadoMeta] || 'pendiente', message: 'Enviada a revisión de Meta.' };
}

// ── POST /plantillas-sistema — envía a revisión una o todas ───────────
//    body: { uso?: 'recordatorio_cita', texto?: 'texto editado con [nombre]…' }   (sin uso = todas)
router.post('/plantillas-sistema', async (req, res, next) => {
  try {
    const { tenantId, cfg, token, wabaId } = await cuentaConectada(req);
    const { clinica, telefono } = await datosClinica(tenantId);
    try { await req.db.query('SELECT 1 FROM wa_meta_plantillas LIMIT 1'); }
    catch (e) { if (errorSinMigracion(e)) throw faltaMigracion(); throw e; }

    const uso   = req.body?.uso ? String(req.body.uso) : null;
    const texto = req.body?.texto ? String(req.body.texto).trim() : null;
    const defs  = uso ? USOS_SISTEMA.filter(d => d.uso === uso) : USOS_SISTEMA;
    if (!defs.length) return res.status(422).json({ success: false, message: 'Tipo de recordatorio desconocido.' });
    if (texto && texto.length > 1024) return res.status(422).json({ success: false, message: 'El mensaje no puede pasar de 1024 caracteres.' });

    const ctx = { cfg, token, wabaId, clinica, telefono };
    const resultados = [];
    for (const def of defs) {
      try { resultados.push(await enviarPlantillaSistema(req, ctx, def, uso ? texto : null)); }
      catch (e) { resultados.push({ uso: def.uso, ok: false, message: e.message }); }
    }
    const fallidas = resultados.filter(r => !r.ok);
    logger.info(`[wa-meta] Plantillas del sistema clínica ${tenantId}: ${resultados.map(r => r.uso + '=' + (r.ok ? r.estado : 'error')).join(', ')}`);
    return res.status(fallidas.length === resultados.length ? 422 : 200).json({
      success: fallidas.length < resultados.length,
      message: fallidas.length
        ? (fallidas.length === resultados.length ? fallidas[0].message : `${resultados.length - fallidas.length} enviadas, ${fallidas.length} con error.`)
        : (defs.length > 1 ? 'Plantillas enviadas a revisión de Meta.' : resultados[0].message),
      data: resultados,
    });
  } catch (err) { responderError(res, next, err); }
});

// ── GET/PUT /recordatorios — misma configuración que la pantalla QR (wa_config) ──
const CAMPOS_RECORDATORIO = {
  activo: 'bool', recordatorio_citas_activo: 'bool', recordatorio_citas_horas: 'horas', recordatorio_citas_horas2: 'horas?',
  recordatorio_vacunas_activo: 'bool', recordatorio_vacunas_dias: 'dias', recordatorio_vacunas_dias2: 'dias?',
  recordatorio_desparasitaciones_activo: 'bool',
};

router.get('/recordatorios', async (req, res, next) => {
  try {
    const [cfg] = await req.db.query('SELECT * FROM wa_config LIMIT 1');
    const data = {};
    for (const k of Object.keys(CAMPOS_RECORDATORIO)) data[k] = cfg ? cfg[k] : null;
    data.codigo_pais = cfg?.codigo_pais || '+51';
    return res.json({ success: true, data });
  } catch (err) { responderError(res, next, err); }
});

router.put('/recordatorios', async (req, res, next) => {
  try {
    const b = req.body || {};
    const val = {};
    for (const [k, tipo] of Object.entries(CAMPOS_RECORDATORIO)) {
      const v = b[k];
      if (tipo === 'bool') { val[k] = v ? 1 : 0; continue; }
      const opcional = tipo.endsWith('?');
      if ((v === null || v === '' || v === undefined) && opcional) { val[k] = null; continue; }
      const n = parseInt(v, 10);
      const max = tipo.startsWith('horas') ? 168 : 60;
      if (!Number.isInteger(n) || n < 1 || n > max) {
        return res.status(422).json({ success: false, message: `Valor inválido en ${k.replace(/_/g, ' ')} (1 a ${max}).` });
      }
      val[k] = n;
    }
    const cols = Object.keys(val);
    const [cfg] = await req.db.query('SELECT id FROM wa_config LIMIT 1');
    if (cfg) {
      await req.db.query(`UPDATE wa_config SET ${cols.map(c => `${c}=?`).join(', ')} WHERE id=?`, [...cols.map(c => val[c]), cfg.id]);
    } else {
      await req.db.query(`INSERT INTO wa_config (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => val[c]));
    }
    return res.json({ success: true, message: 'Recordatorios guardados.' });
  } catch (err) { responderError(res, next, err); }
});

// ════════════════════════════════════════════════════════════════════
//  CAMPAÑAS POR META (las envía el procesador wa-campanas)
// ════════════════════════════════════════════════════════════════════

const SEGMENTOS = ['todos', 'por_especie', 'vacunas_vencidas', 'citas_semana', 'sin_citas_60d'];
const DATOS_CAMPANA = { nombre: 'Nombre del cliente', mascota: 'Mascota(s)', clinica: 'Nombre de la clínica' };

// Misma consulta que usa el procesador wa-campanas (mantener iguales)
function sqlSegmento(segmento, valor) {
  const nombre = `COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.nombre,''),' ',COALESCE(p.apellido,''))),''), p.razon_social)`;
  const base = (joins, where, params = []) => ({
    sql: `SELECT p.id, ${nombre} AS nombre, p.telefono,
                 GROUP_CONCAT(DISTINCT m.nombre ORDER BY m.id SEPARATOR ', ') AS mascotas
          FROM propietarios p ${joins}
          WHERE p.telefono IS NOT NULL AND TRIM(p.telefono) <> '' ${where}
          GROUP BY p.id`,
    params,
  });
  switch (segmento) {
    case 'todos':            return base('LEFT JOIN mascotas m ON m.propietario_id = p.id', '');
    case 'por_especie':      return base('JOIN mascotas m ON m.propietario_id = p.id', 'AND m.especie = ?', [String(valor || '')]);
    case 'vacunas_vencidas': return base('JOIN mascotas m ON m.propietario_id = p.id JOIN vacunas v ON v.mascota_id = m.id',
                                         'AND v.proxima_dosis < CURDATE() AND v.notificado = 0');
    case 'citas_semana':     return base('JOIN mascotas m ON m.propietario_id = p.id JOIN citas c ON c.mascota_id = m.id',
                                         "AND c.fecha_hora BETWEEN NOW() AND NOW() + INTERVAL 7 DAY AND c.estado IN ('pendiente','confirmada')");
    case 'sin_citas_60d':    return base('LEFT JOIN mascotas m ON m.propietario_id = p.id',
                                         `AND NOT EXISTS (SELECT 1 FROM citas c2 JOIN mascotas m2 ON m2.id = c2.mascota_id
                                                          WHERE m2.propietario_id = p.id AND c2.fecha_hora >= NOW() - INTERVAL 60 DAY)`);
    default: return null;
  }
}

// ── GET /campanas/contar?segmento=&valor= — cuántos clientes recibirían ──
router.get('/campanas/contar', async (req, res, next) => {
  try {
    const q = sqlSegmento(String(req.query.segmento || ''), req.query.valor);
    if (!q) return res.status(422).json({ success: false, message: 'Segmento inválido.' });
    const [r] = await req.db.query(`SELECT COUNT(*) AS n FROM (${q.sql}) x`, q.params);
    return res.json({ success: true, data: { total: Number(r?.n || 0) } });
  } catch (err) { responderError(res, next, err); }
});

// ── GET /campanas/especies — especies registradas (para el segmento "por especie") ──
router.get('/campanas/especies', async (req, res, next) => {
  try {
    const rows = await req.db.query(
      `SELECT m.especie, COUNT(DISTINCT p.id) AS clientes
       FROM mascotas m JOIN propietarios p ON p.id = m.propietario_id
       WHERE m.especie IS NOT NULL AND TRIM(m.especie) <> '' AND p.telefono IS NOT NULL AND TRIM(p.telefono) <> ''
       GROUP BY m.especie ORDER BY clientes DESC LIMIT 30`
    );
    return res.json({ success: true, data: rows });
  } catch (err) { responderError(res, next, err); }
});

// ── GET /campanas — campañas por Meta ────────────────────────────────
router.get('/campanas', async (req, res, next) => {
  try {
    let rows;
    try {
      rows = await req.db.query(
        `SELECT c.id, c.nombre, c.mensaje, (c.imagen_url LIKE 'meta-media:%') AS con_imagen, c.segmento, c.segmento_valor, c.estado, c.total, c.enviados, c.fallidos,
                c.programada_at, c.iniciada_at, c.completada_at, c.created_at, p.nombre_meta AS plantilla
         FROM wa_campanas c LEFT JOIN wa_meta_plantillas p ON p.id = c.meta_plantilla_id
         WHERE c.proveedor = 'meta' ORDER BY c.id DESC LIMIT 100`
      );
    } catch (e) { if (errorSinMigracion(e)) throw faltaMigracion(); throw e; }
    return res.json({ success: true, data: rows });
  } catch (err) { responderError(res, next, err); }
});

// ── POST /campanas — crea una campaña con una plantilla aprobada ─────
//    body: { nombre, plantilla:'nombre|idioma', variables:[{tipo:'dato'|'fijo', valor}], segmento, segmento_valor, programada_at }
router.post('/campanas', async (req, res, next) => {
  try {
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim().slice(0, 150);
    if (!nombre) return res.status(422).json({ success: false, message: 'Ponle un nombre a la campaña.' });
    const segmento = String(b.segmento || 'todos');
    if (!SEGMENTOS.includes(segmento)) return res.status(422).json({ success: false, message: 'Elige a quién enviar.' });
    const segValor = segmento === 'por_especie' ? String(b.segmento_valor || '').trim() : null;
    if (segmento === 'por_especie' && !segValor) return res.status(422).json({ success: false, message: 'Elige la especie.' });

    let programada = null;
    if (b.programada_at) {
      programada = new Date(b.programada_at);
      if (isNaN(programada)) return res.status(422).json({ success: false, message: 'Fecha de programación inválida.' });
      if (programada < new Date(Date.now() - 5 * 60000)) return res.status(422).json({ success: false, message: 'La fecha programada ya pasó.' });
    }

    const [pNombre, pIdioma] = String(b.plantilla || '').split('|');
    if (!/^[a-z0-9_]{1,512}$/.test(pNombre || '')) return res.status(422).json({ success: false, message: 'Elige una plantilla aprobada.' });

    const { cfg, token, wabaId } = await cuentaConectada(req);
    const t = (await plantillasMeta(cfg, token, wabaId, pNombre)).find(x => x.name === pNombre && (!pIdioma || x.language === pIdioma));
    if (!t) return res.status(422).json({ success: false, message: 'La plantilla ya no existe en Meta.' });
    if (t.status !== 'APPROVED') return res.status(422).json({ success: false, message: 'La plantilla todavía no está aprobada por Meta.' });
    const vt = vistaPlantillaMeta(t);
    let imagenUrl = null;
    if (vt.encabezado_formato && !['TEXT', 'IMAGE'].includes(vt.encabezado_formato)) {
      return res.status(422).json({ success: false, message: 'Las campañas usan plantillas de texto o con imagen (no video ni documento).' });
    }
    if (vt.encabezado_formato === 'IMAGE') {
      const mediaId = String(b.imagen_media_id || '').trim();
      if (!/^\d{5,30}$/.test(mediaId)) return res.status(422).json({ success: false, message: 'Esta plantilla lleva imagen: elige la imagen de la campaña.' });
      imagenUrl = 'meta-media:' + mediaId;   // id de la imagen subida a Meta (dura 30 días)
    }
    const tenantIdCamp = await tenantIdDe(req);
    const blobNombre = imagenUrl && String(b.imagen_blob || '').startsWith(`meta/${tenantIdCamp}/`) ? String(b.imagen_blob).slice(0, 200) : null;

    const vars = Array.isArray(b.variables) ? b.variables : [];
    if (vars.length < vt.variables) return res.status(422).json({ success: false, message: 'Indica qué va en cada variable de la plantilla.' });
    const mapeo = [];
    for (let i = 0; i < vt.variables; i++) {
      const v = vars[i] || {};
      if (v.tipo === 'dato' && DATOS_CAMPANA[v.valor]) mapeo.push({ tipo: 'dato', valor: v.valor });
      else if (v.tipo === 'fijo' && String(v.valor || '').trim()) mapeo.push({ tipo: 'fijo', valor: String(v.valor).trim().replace(/\s+/g, ' ').slice(0, 200) });
      else return res.status(422).json({ success: false, message: `Completa la variable {{${i + 1}}}.` });
    }
    const vista = vt.cuerpo.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => {
      const m = mapeo[n - 1]; return !m ? '' : m.tipo === 'dato' ? `[${m.valor}]` : m.valor;
    });

    // Asegura la plantilla en la base de la clínica
    let plantillaId;
    try {
      await req.db.query(
        `INSERT INTO wa_meta_plantillas (nombre_meta, idioma, categoria, uso, cuerpo, meta_template_id, estado, es_estandar, activo)
         VALUES (?,?,?, 'campana', ?,?, 'aprobada', 0, 1)
         ON DUPLICATE KEY UPDATE categoria=VALUES(categoria), cuerpo=VALUES(cuerpo), meta_template_id=VALUES(meta_template_id),
           estado='aprobada', activo=1`,
        [t.name, t.language, ['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(t.category) ? t.category : 'MARKETING', vt.cuerpo, t.id]
      );
      const [fila] = await req.db.query('SELECT id FROM wa_meta_plantillas WHERE nombre_meta=? AND idioma=?', [t.name, t.language]);
      plantillaId = fila.id;
      const r = await req.db.query(
        `INSERT INTO wa_campanas (nombre, mensaje, imagen_url, imagen_blob_name, segmento, segmento_valor, estado, programada_at, proveedor, meta_plantilla_id, meta_variables)
         VALUES (?,?,?,?,?,?,?,?, 'meta', ?, ?)`,
        [nombre, vista, imagenUrl, blobNombre, segmento, segValor, programada ? 'programada' : 'borrador', programada, plantillaId, JSON.stringify(mapeo)]
      );
      return res.status(201).json({ success: true, message: programada ? 'Campaña programada.' : 'Campaña creada.', data: { id: r.insertId } });
    } catch (e) { if (errorSinMigracion(e)) throw faltaMigracion(); throw e; }
  } catch (err) { responderError(res, next, err); }
});

// ── POST /campanas/:id/:accion — iniciar | pausar | reanudar | cancelar ──
router.post('/campanas/:id/:accion', async (req, res, next) => {
  try {
    const acciones = {
      iniciar : { desde: ['borrador'],                         sql: "estado='enviando', iniciada_at=IFNULL(iniciada_at, NOW())" },
      pausar  : { desde: ['enviando', 'programada'],           sql: "estado='pausada', pausada_at=NOW()" },
      reanudar: { desde: ['pausada'],                          sql: "estado='enviando', iniciada_at=IFNULL(iniciada_at, NOW())" },
      cancelar: { desde: ['borrador', 'programada', 'enviando', 'pausada'], sql: "estado='cancelada'" },
    };
    const a = acciones[req.params.accion];
    if (!a) return res.status(404).json({ success: false, message: 'Acción no válida.' });
    const [c] = await req.db.query("SELECT id, estado FROM wa_campanas WHERE id=? AND proveedor='meta'", [req.params.id]);
    if (!c) return res.status(404).json({ success: false, message: 'Campaña no encontrada.' });
    if (!a.desde.includes(c.estado)) return res.status(422).json({ success: false, message: `No se puede ${req.params.accion} una campaña ${c.estado}.` });
    if (req.params.accion !== 'pausar' && req.params.accion !== 'cancelar') await cuentaConectada(req);
    await req.db.query(`UPDATE wa_campanas SET ${a.sql} WHERE id=?`, [c.id]);
    const textos = { iniciar: 'Campaña iniciada.', pausar: 'Campaña pausada.', reanudar: 'Campaña reanudada.', cancelar: 'Campaña cancelada.' };
    return res.json({ success: true, message: textos[req.params.accion] });
  } catch (err) { responderError(res, next, err); }
});

// ── DELETE /campanas/:id — solo borradores, canceladas o completadas ──
router.delete('/campanas/:id', async (req, res, next) => {
  try {
    const [c] = await req.db.query("SELECT id, estado, imagen_blob_name FROM wa_campanas WHERE id=? AND proveedor='meta'", [req.params.id]);
    if (!c) return res.status(404).json({ success: false, message: 'Campaña no encontrada.' });
    if (!['borrador', 'cancelada', 'completada'].includes(c.estado)) {
      return res.status(422).json({ success: false, message: 'Pausa o cancela la campaña antes de eliminarla.' });
    }
    await req.db.query('DELETE FROM wa_campanas WHERE id=?', [c.id]);
    if (c.imagen_blob_name) await borrarDeBlob(c.imagen_blob_name);
    return res.json({ success: true, message: 'Campaña eliminada.' });
  } catch (err) { responderError(res, next, err); }
});

// ── GET /consumo — mensajes enviados por Meta en el mes ──────────────
router.get('/consumo', async (req, res, next) => {
  try {
    const tenantId = await tenantIdDe(req);
    const [g] = await masterQuery('SELECT meta_alerta_mensual FROM wa_config_global WHERE tenant_id=?', [tenantId]);
    let porTipo = [];
    try {
      porTipo = await req.db.query(
        `SELECT tipo, estado, COUNT(*) AS n FROM wa_mensajes_log
         WHERE proveedor='meta' AND created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
         GROUP BY tipo, estado`
      );
    } catch (e) { if (errorSinMigracion(e)) throw faltaMigracion(); throw e; }
    const ok = porTipo.filter(r => r.estado !== 'fallido');
    const total = ok.reduce((a, r) => a + Number(r.n), 0);
    const resumen = {};
    for (const r of porTipo) {
      resumen[r.tipo] = resumen[r.tipo] || { enviados: 0, fallidos: 0 };
      if (r.estado === 'fallido') resumen[r.tipo].fallidos += Number(r.n); else resumen[r.tipo].enviados += Number(r.n);
    }
    const alerta = Number(g?.meta_alerta_mensual || 1000);
    return res.json({ success: true, data: { mes: new Date().toISOString().slice(0, 7), total, alerta, supera: total >= alerta, por_tipo: resumen } });
  } catch (err) { responderError(res, next, err); }
});

module.exports = router;