'use strict';

/**
 * VetClinic SaaS — WhatsApp Routes (tenant)
 * Base: /api/v1/wa
 * Actúa como proxy entre el tenant y el WA Gateway
 */

const { Router } = require('express');
const http       = require('http');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = Router();
router.use(authenticate);

const WA_GATEWAY = process.env.WA_GATEWAY_URL || 'http://localhost:5000';
const INTERNAL_KEY = process.env.WA_INTERNAL_KEY || 'wa-internal-secret-2026';

// ── Helper — llamar al gateway ────────────────────────────────
function callGateway(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const url     = new URL(WA_GATEWAY + path);
    const options = {
      hostname: url.hostname,
      port    : url.port || 5000,
      path    : url.pathname,
      method,
      headers : {
        'Content-Type'  : 'application/json',
        'x-internal-key': INTERNAL_KEY,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: { success: false } }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout WA Gateway')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Helper — obtener info del tenant desde BD
async function getTenantInfo(req) {
  const host = req.headers['x-tenant-host'] || req.hostname;
  const { masterQuery } = require('../config/masterDB');
  const [t] = await masterQuery(
    `SELECT t.id, t.slug, tc.nombre_clinica
     FROM tenants t
     LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
     WHERE t.subdominio = ? LIMIT 1`,
    [host]
  ).catch(() => [null]);
  return t;
}

// ── GET /api/v1/wa/estado ─────────────────────────────────────
router.get('/estado', async (req, res, next) => {
  try {
    const t = await getTenantInfo(req);
    if (!t) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });

    const r = await callGateway('GET', `/wa/sesion/${t.id}/estado`);
    return res.json(r.data);
  } catch (err) { next(err); }
});

// ── GET /api/v1/wa/config ─────────────────────────────────────
router.get('/config', async (req, res, next) => {
  try {
    const [cfg] = await req.db.query('SELECT * FROM wa_config LIMIT 1');
    const { masterQuery } = require('../config/masterDB');
    const t = await getTenantInfo(req);
    const [cuota] = t ? await masterQuery(
      'SELECT ilimitado, msgs_incluidos, msgs_usados FROM wa_config_global WHERE tenant_id=?',
      [t.id]
    ) : [null];

    return res.json({
      success: true,
      data: {
        config: cfg || {},
        cuota : cuota || { ilimitado: false, msgs_incluidos: 0, msgs_usados: 0 },
      },
    });
  } catch (err) { next(err); }
});

// ── PUT /api/v1/wa/config — solo admin ───────────────────────
router.put('/config', authorize('admin'), async (req, res, next) => {
  try {
    const {
      activo, codigo_pais,
      recordatorio_citas_activo, recordatorio_citas_horas, recordatorio_citas_horas2,
      recordatorio_vacunas_activo, recordatorio_vacunas_dias, recordatorio_vacunas_dias2,
      recordatorio_desparasitaciones_activo,
    } = req.body;

    await req.db.query(
      `UPDATE wa_config SET
         activo=?, codigo_pais=?,
         recordatorio_citas_activo=?, recordatorio_citas_horas=?, recordatorio_citas_horas2=?,
         recordatorio_vacunas_activo=?, recordatorio_vacunas_dias=?, recordatorio_vacunas_dias2=?,
         recordatorio_desparasitaciones_activo=?
       WHERE id=1`,
      [
        activo ? 1 : 0,
        codigo_pais || '+51',
        recordatorio_citas_activo ? 1 : 0,
        recordatorio_citas_horas || 24,
        recordatorio_citas_horas2 || null,
        recordatorio_vacunas_activo ? 1 : 0,
        recordatorio_vacunas_dias || 7,
        recordatorio_vacunas_dias2 || null,
        recordatorio_desparasitaciones_activo ? 1 : 0,
      ]
    );
    return res.json({ success: true, message: 'Configuración WA guardada.' });
  } catch (err) { next(err); }
});

// ── POST /api/v1/wa/conectar — solo admin ────────────────────
router.post('/conectar', authorize('admin'), async (req, res, next) => {
  try {
    const t = await getTenantInfo(req);
    if (!t) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });

    const r = await callGateway('POST', '/wa/sesion/iniciar', {
      tenantId    : t.id,
      tenantSlug  : t.slug,
      tenantNombre: t.nombre_clinica,
    });
    return res.status(r.status).json(r.data);
  } catch (err) { next(err); }
});

// ── POST /api/v1/wa/desconectar — solo admin ─────────────────
router.post('/desconectar', authorize('admin'), async (req, res, next) => {
  try {
    const t = await getTenantInfo(req);
    if (!t) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });

    const r = await callGateway('POST', '/wa/sesion/desconectar', {
      tenantId  : t.id,
      tenantSlug: t.slug,
    });
    return res.status(r.status).json(r.data);
  } catch (err) { next(err); }
});

// ── GET /api/v1/wa/qr ─────────────────────────────────────────
router.get('/qr', authorize('admin'), async (req, res, next) => {
  try {
    const t = await getTenantInfo(req);
    if (!t) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });

    const r = await callGateway('GET', `/wa/sesion/${t.id}/qr`);
    return res.status(r.status).json(r.data);
  } catch (err) { next(err); }
});

// ── POST /api/v1/wa/enviar — admin + recepcionista ────────────
router.post('/enviar', authorize('admin', 'recepcionista'), async (req, res, next) => {
  try {
    const { telefono, mensaje, propietario_id } = req.body;
    if (!telefono || !mensaje) {
      return res.status(422).json({ success: false, message: 'telefono y mensaje son requeridos' });
    }

    const t = await getTenantInfo(req);
    if (!t) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });

    // Verificar que WA está activo para este tenant
    const [cfg] = await req.db.query('SELECT activo, codigo_pais FROM wa_config LIMIT 1');
    if (!cfg?.activo) {
      return res.status(422).json({ success: false, message: 'WhatsApp no está activo para esta clínica.' });
    }

    const r = await callGateway('POST', '/wa/enviar', {
      tenantId      : t.id,
      telefono,
      mensaje,
      propietarioId : propietario_id || null,
      tipo          : 'manual',
      codigoPais    : cfg.codigo_pais || '+51',
    });
    return res.status(r.status).json(r.data);
  } catch (err) { next(err); }
});

// ── GET /api/v1/wa/plantillas ─────────────────────────────────
router.get('/plantillas', async (req, res, next) => {
  try {
    const rows = await req.db.query('SELECT * FROM wa_plantillas WHERE activo=1 ORDER BY tipo,nombre');
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── POST /api/v1/wa/plantillas — solo admin ───────────────────
router.post('/plantillas', authorize('admin'), async (req, res, next) => {
  try {
    const { nombre, tipo, contenido } = req.body;
    if (!nombre || !contenido) {
      return res.status(422).json({ success: false, message: 'nombre y contenido requeridos' });
    }
    const r = await req.db.query(
      'INSERT INTO wa_plantillas (nombre, tipo, contenido) VALUES (?,?,?)',
      [nombre, tipo || 'manual', contenido]
    );
    return res.status(201).json({ success: true, data: { id: r.insertId } });
  } catch (err) { next(err); }
});

// ── PUT /api/v1/wa/plantillas/:id — solo admin ────────────────
router.put('/plantillas/:id', authorize('admin'), async (req, res, next) => {
  try {
    const { nombre, tipo, contenido, activo } = req.body;
    await req.db.query(
      'UPDATE wa_plantillas SET nombre=?, tipo=?, contenido=?, activo=? WHERE id=?',
      [nombre, tipo, contenido, activo ? 1 : 0, req.params.id]
    );
    return res.json({ success: true, message: 'Plantilla actualizada.' });
  } catch (err) { next(err); }
});

// ── GET /api/v1/wa/log ────────────────────────────────────────
router.get('/log', authorize('admin'), async (req, res, next) => {
  try {
    const { tipo, estado, limit = 50 } = req.query;
    let sql = `SELECT l.*, CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre
               FROM wa_mensajes_log l
               LEFT JOIN propietarios p ON p.id = l.propietario_id
               WHERE 1=1`;
    const params = [];
    if (tipo)   { sql += ' AND l.tipo=?';   params.push(tipo); }
    if (estado) { sql += ' AND l.estado=?'; params.push(estado); }
    sql += ` ORDER BY l.created_at DESC LIMIT ${Math.min(parseInt(limit)||50, 200)}`;
    const rows = await req.db.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

module.exports = router;