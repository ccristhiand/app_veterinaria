'use strict';

/**
 * VetClinic SaaS — Admin WA Routes
 * Base: /admin/api/wa
 *
 * Controla por clínica:
 *  - WhatsApp activo / cuota de mensajes (Baileys)
 *  - Qué pantallas ve la clínica: WhatsApp (QR) y/o WhatsApp Meta
 *  - Umbral de aviso mensual de mensajes Meta
 */

const { Router }      = require('express');
const jwt             = require('jsonwebtoken');
const { masterQuery } = require('../config/masterDB');

const router       = Router();
const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'admin-secret';

// ── Auth admin (antes estas rutas quedaban abiertas) ─────────────
router.use((req, res, next) => {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Token requerido.' });
  try {
    req.adminUser = jwt.verify(token, ADMIN_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token inválido.' });
  }
});

// ════════════════════════════════════════════════════════════════
//  Configuración Meta de la PLATAFORMA (una sola para todas las clínicas)
//  Se guarda en saas_config (clave/valor). El App Secret va cifrado.
// ════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const { encrypt, decrypt } = require('../services/crypto.service');

const META_CLAVES = {
  app_id      : 'meta_app_id',
  app_secret  : 'meta_app_secret',     // cifrado
  config_id   : 'meta_config_id',
  verify_token: 'meta_verify_token',
  graph_ver   : 'meta_graph_version',
  public_url  : 'meta_public_url',
};
const META_DEF = { graph_ver: 'v25.0', public_url: 'https://wameta.netcodip.com' };

async function leerMeta() {
  const rows = await masterQuery(
    `SELECT clave, valor FROM saas_config WHERE clave IN (${Object.values(META_CLAVES).map(() => '?').join(',')})`,
    Object.values(META_CLAVES)
  );
  const map = Object.fromEntries(rows.map(r => [r.clave, r.valor]));
  const out = {};
  for (const [k, clave] of Object.entries(META_CLAVES)) out[k] = map[clave] || META_DEF[k] || '';
  return out;
}

async function guardarMeta(k, valor, descripcion) {
  await masterQuery(
    `INSERT INTO saas_config (clave, valor, descripcion) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
    [META_CLAVES[k], valor ?? '', descripcion]
  );
}

function vistaMeta(m) {
  const base = (m.public_url || META_DEF.public_url).replace(/\/+$/, '');
  return {
    app_id      : m.app_id,
    config_id   : m.config_id,
    graph_ver   : m.graph_ver,
    public_url  : base,
    webhook_url : `${base}/webhook`,
    verify_token: m.verify_token,
    tiene_secret: !!m.app_secret,
    completa    : !!(m.app_id && m.app_secret && m.config_id && m.verify_token),
  };
}

// GET /admin/api/wa/plataforma-meta
router.get('/plataforma-meta', async (req, res, next) => {
  try {
    const m = await leerMeta();
    // Primera vez: generar el token de verificación del webhook
    if (!m.verify_token) {
      m.verify_token = crypto.randomBytes(24).toString('hex');
      await guardarMeta('verify_token', m.verify_token, 'Token de verificación del webhook de Meta');
    }
    return res.json({ success: true, data: vistaMeta(m) });
  } catch (err) { next(err); }
});

// PUT /admin/api/wa/plataforma-meta
// El App Secret solo se cambia si se envía uno nuevo (vacío = conservar el actual).
router.put('/plataforma-meta', async (req, res, next) => {
  try {
    const b = req.body || {};
    const appId    = String(b.app_id    || '').trim();
    const configId = String(b.config_id || '').trim();
    const secret   = String(b.app_secret || '').trim();
    const graphVer = String(b.graph_ver || META_DEF.graph_ver).trim();
    const pubUrl   = String(b.public_url || META_DEF.public_url).trim().replace(/\/+$/, '');

    if (appId    && !/^\d{5,25}$/.test(appId))    return res.status(422).json({ success: false, message: 'El App ID debe ser solo números.' });
    if (configId && !/^\d{5,25}$/.test(configId)) return res.status(422).json({ success: false, message: 'El Configuration ID debe ser solo números.' });
    if (secret   && !/^[a-f0-9]{32}$/i.test(secret)) return res.status(422).json({ success: false, message: 'La clave secreta debe tener 32 caracteres (letras a-f y números).' });
    if (!/^v\d{2}\.\d$/.test(graphVer))           return res.status(422).json({ success: false, message: 'Versión de Graph API inválida (ej. v25.0).' });
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(pubUrl)) return res.status(422).json({ success: false, message: 'La URL pública debe empezar con https:// y no llevar rutas.' });

    await guardarMeta('app_id',     appId,    'App ID de Meta (VetNetcodip)');
    await guardarMeta('config_id',  configId, 'Configuration ID de Embedded Signup');
    await guardarMeta('graph_ver',  graphVer, 'Versión de Graph API');
    await guardarMeta('public_url', pubUrl,   'URL pública del servicio wa-meta');
    if (secret) await guardarMeta('app_secret', encrypt(secret), 'App Secret de Meta (cifrado)');

    return res.json({ success: true, message: 'Configuración Meta guardada.', data: vistaMeta(await leerMeta()) });
  } catch (err) { next(err); }
});

// POST /admin/api/wa/plataforma-meta/token — generar un token de verificación nuevo
router.post('/plataforma-meta/token', async (req, res, next) => {
  try {
    const token = crypto.randomBytes(24).toString('hex');
    await guardarMeta('verify_token', token, 'Token de verificación del webhook de Meta');
    return res.json({ success: true, data: vistaMeta(await leerMeta()) });
  } catch (err) { next(err); }
});

// POST /admin/api/wa/plataforma-meta/probar — valida App ID + App Secret contra Meta
router.post('/plataforma-meta/probar', async (req, res, next) => {
  try {
    const m = await leerMeta();
    if (!m.app_id || !m.app_secret) {
      return res.status(422).json({ success: false, message: 'Primero guarda el App ID y la clave secreta.' });
    }
    let secret;
    try { secret = decrypt(m.app_secret); }
    catch { return res.status(422).json({ success: false, message: 'No se pudo leer la clave secreta guardada. Vuelve a pegarla.' }); }

    const url = `https://graph.facebook.com/${m.graph_ver}/${encodeURIComponent(m.app_id)}` +
                `?fields=id,name&access_token=${encodeURIComponent(m.app_id + '|' + secret)}`;
    let r, d;
    try {
      r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      d = await r.json();
    } catch (e) {
      return res.status(502).json({ success: false, message: 'No se pudo conectar con Meta: ' + e.message });
    }
    if (!r.ok || d.error) {
      return res.status(422).json({
        success: false,
        message: 'Meta rechazó los datos: ' + (d.error?.message || 'App ID o clave secreta incorrectos.'),
      });
    }
    return res.json({
      success: true,
      message: `Conexión correcta con la app "${d.name}".`,
      data: { app_name: d.name, config_id_ok: !!m.config_id },
    });
  } catch (err) { next(err); }
});

const DEFAULTS = {
  activo: 0, ilimitado: 0, msgs_incluidos: 100, msgs_usados: 0,
  ver_qr: 1, ver_meta: 0, meta_alerta_mensual: 1000,
};

// ── GET /admin/api/wa/estado-global ──────────────────────────────
// DEBE ir antes de /:tenantId
// Parte de tenants (no de wa_sesiones) para incluir clínicas que solo usan Meta.
router.get('/estado-global', async (req, res, next) => {
  try {
    const rows = await masterQuery(
      `SELECT t.id AS tenant_id, t.slug, t.subdominio, tc.nombre_clinica,
              ws.estado, ws.numero_wa, ws.ultima_conexion,
              wcg.activo, wcg.ilimitado, wcg.msgs_incluidos, wcg.msgs_usados,
              COALESCE(wcg.ver_qr, 1)                AS ver_qr,
              COALESCE(wcg.ver_meta, 0)              AS ver_meta,
              COALESCE(wcg.meta_alerta_mensual, 1000) AS meta_alerta_mensual,
              wm.estado         AS meta_estado,
              wm.numero_display AS meta_numero,
              wm.coexistencia   AS meta_coexistencia,
              wm.calidad        AS meta_calidad
       FROM tenants t
       LEFT JOIN tenant_config    tc  ON tc.tenant_id  = t.id
       LEFT JOIN wa_sesiones      ws  ON ws.tenant_id  = t.id
       LEFT JOIN wa_config_global wcg ON wcg.tenant_id = t.id
       LEFT JOIN wa_meta_cuentas  wm  ON wm.tenant_id  = t.id
       WHERE t.activo = 1
       ORDER BY tc.nombre_clinica`
    );

    // Proveedor que se usa realmente para enviar
    for (const r of rows) {
      r.proveedor_activo = (r.ver_meta && r.meta_estado === 'conectado') ? 'meta' : 'qr';
    }
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /admin/api/wa/:tenantId/config ────────────────────────────
router.get('/:tenantId/config', async (req, res, next) => {
  try {
    const [cfg] = await masterQuery(
      `SELECT activo, ilimitado, msgs_incluidos, msgs_usados, mes_actual,
              ver_qr, ver_meta, meta_alerta_mensual
       FROM wa_config_global WHERE tenant_id=?`,
      [req.params.tenantId]
    );
    const [meta] = await masterQuery(
      `SELECT estado, numero_display, nombre_verificado, coexistencia, calidad, conectado_at
       FROM wa_meta_cuentas WHERE tenant_id=?`,
      [req.params.tenantId]
    );
    return res.json({
      success: true,
      data: { ...DEFAULTS, ...(cfg || {}), meta: meta || null },
    });
  } catch (err) { next(err); }
});

// ── PUT /admin/api/wa/:tenantId/config ────────────────────────────
// Solo cambia los campos enviados; el resto se conserva.
router.put('/:tenantId/config', async (req, res, next) => {
  try {
    const { tenantId } = req.params;

    const [t] = await masterQuery('SELECT id FROM tenants WHERE id=?', [tenantId]);
    if (!t) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });

    const [actual] = await masterQuery(
      `SELECT activo, ilimitado, msgs_incluidos, ver_qr, ver_meta, meta_alerta_mensual
       FROM wa_config_global WHERE tenant_id=?`, [tenantId]
    );
    const base = { ...DEFAULTS, ...(actual || {}) };
    const b    = req.body || {};
    const bool = (v, def) => (v === undefined ? (def ? 1 : 0) : (v ? 1 : 0));
    const ent  = (v, def, min = 1) => {
      if (v === undefined) return def;
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n >= min ? n : def;
    };

    const nuevo = {
      activo             : bool(b.activo,    base.activo),
      ilimitado          : bool(b.ilimitado, base.ilimitado),
      msgs_incluidos     : ent(b.msgs_incluidos, base.msgs_incluidos),
      ver_qr             : bool(b.ver_qr,    base.ver_qr),
      ver_meta           : bool(b.ver_meta,  base.ver_meta),
      meta_alerta_mensual: ent(b.meta_alerta_mensual, base.meta_alerta_mensual),
    };

    await masterQuery(
      `INSERT INTO wa_config_global
         (tenant_id, activo, ilimitado, msgs_incluidos, ver_qr, ver_meta, meta_alerta_mensual)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         activo=VALUES(activo), ilimitado=VALUES(ilimitado),
         msgs_incluidos=VALUES(msgs_incluidos),
         ver_qr=VALUES(ver_qr), ver_meta=VALUES(ver_meta),
         meta_alerta_mensual=VALUES(meta_alerta_mensual)`,
      [tenantId, nuevo.activo, nuevo.ilimitado, nuevo.msgs_incluidos,
       nuevo.ver_qr, nuevo.ver_meta, nuevo.meta_alerta_mensual]
    );

    return res.json({ success: true, message: 'Configuración WA guardada.', data: nuevo });
  } catch (err) { next(err); }
});

module.exports = router;