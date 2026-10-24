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

// ── GET /plantillas — lista las plantillas de la clínica en Meta ─────
router.get('/plantillas', async (req, res, next) => {
  try {
    const { cfg, token, wabaId } = await cuentaConectada(req);
    const d = await graph('GET', `${wabaId}/message_templates`, {
      cfg, token, query: { fields: 'id,name,language,status,category,components,rejected_reason', limit: '200' },
    });
    const data = (d.data || []).map(t => {
      const body   = (t.components || []).find(c => c.type === 'BODY');
      const header = (t.components || []).find(c => c.type === 'HEADER' && c.format === 'TEXT');
      const footer = (t.components || []).find(c => c.type === 'FOOTER');
      return {
        id: t.id, nombre: t.name, idioma: t.language, estado: t.status, categoria: t.category,
        cuerpo: body?.text || '', encabezado: header?.text || '', pie: footer?.text || '',
        variables: [...new Set(variablesDe(body?.text || ''))].length,
        motivo_rechazo: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
      };
    });
    return res.json({ success: true, data });
  } catch (err) { responderError(res, next, err); }
});

// ── POST /plantillas — crea una plantilla y la envía a revisión ──────
router.post('/plantillas', async (req, res, next) => {
  try {
    const b = req.body || {};
    const datos = {
      nombre    : String(b.nombre || '').trim().toLowerCase(),
      categoria : String(b.categoria || '').toUpperCase(),
      idioma    : String(b.idioma || 'es').trim(),
      encabezado: String(b.encabezado || '').trim(),
      cuerpo    : String(b.cuerpo || '').trim(),
      pie       : String(b.pie || '').trim(),
      ejemplos  : Array.isArray(b.ejemplos) ? b.ejemplos.map(e => String(e || '').trim()) : [],
    };
    const problemas = validarPlantilla(datos);
    if (problemas.length) return res.status(422).json({ success: false, message: problemas[0], problemas });

    const { cfg, token, wabaId } = await cuentaConectada(req);
    const nVars = [...new Set(variablesDe(datos.cuerpo))].length;
    const components = [];
    if (datos.encabezado) components.push({ type: 'HEADER', format: 'TEXT', text: datos.encabezado });
    const body = { type: 'BODY', text: datos.cuerpo };
    if (nVars) body.example = { body_text: [datos.ejemplos.slice(0, nVars)] };
    components.push(body);
    if (datos.pie) components.push({ type: 'FOOTER', text: datos.pie });

    const d = await graph('POST', `${wabaId}/message_templates`, {
      cfg, token, body: { name: datos.nombre, language: datos.idioma, category: datos.categoria, components },
    });
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
      const vars = Array.isArray(b.variables) ? b.variables.map(v => String(v ?? '').trim()) : [];
      if (vars.some(v => !v)) return res.status(422).json({ success: false, message: 'Completa todas las variables de la plantilla.' });
      payload = {
        messaging_product: 'whatsapp', to: telefono, type: 'template',
        template: { name: nombre, language: { code: String(b.idioma || 'es') } },
      };
      if (vars.length) payload.template.components = [{ type: 'body', parameters: vars.map(v => ({ type: 'text', text: v })) }];
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
      return res.status(422).json({ success: false, codigo: 133010, message: 'Tu número está conectado pero todavía no está registrado en Meta. Ve a la pestaña «Conexión» y pulsa «Registrar número».' });
    }
    // 132001: la plantilla no existe en ese idioma o aún no está aprobada
    if (err.meta?.code === 132001) {
      return res.status(422).json({ success: false, message: 'La plantilla no existe o todavía no está aprobada por Meta.' });
    }
    responderError(res, next, err);
  }
});

module.exports = router;