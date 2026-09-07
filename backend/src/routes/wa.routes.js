'use strict';

/**
 * VetClinic SaaS — WhatsApp Routes (tenant)
 * Base: /api/v1/wa
 * Actúa como proxy entre el tenant y el WA Gateway
 */

const { Router } = require('express');
const http       = require('http');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

// ── Azure Blob — cliente singleton (no crear uno por request) ─────
let _waAzureClient = null;
function getWABlobClient() {
  if (_waAzureClient) return _waAzureClient;
  const connStr = process.env.AZURE_WA_STORAGE_CONNECTION || process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) return null;
  const { BlobServiceClient } = require('@azure/storage-blob');
  _waAzureClient = BlobServiceClient.fromConnectionString(connStr);
  return _waAzureClient;
}

const router = Router();
router.use(authenticate);

const WA_GATEWAY = process.env.WA_GATEWAY_URL || 'http://localhost:5001';
const INTERNAL_KEY = process.env.WA_INTERNAL_KEY || 'wa-internal-secret-2026';

// ── Helper — llamar al gateway ────────────────────────────────
function callGateway(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const url     = new URL(WA_GATEWAY + path);
    const options = {
      hostname: url.hostname,
      port    : parseInt(url.port) || 5001,
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
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout WA Gateway')); });
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
    const { telefono, mensaje, imagen_base64, imagen_mimetype, propietario_id } = req.body;
    if (!telefono || (!mensaje && !imagen_base64)) {
      return res.status(422).json({ success: false, message: 'telefono y mensaje o imagen son requeridos' });
    }

    const t = await getTenantInfo(req);
    if (!t) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });

    const [cfg] = await req.db.query('SELECT activo, codigo_pais FROM wa_config LIMIT 1');
    if (!cfg?.activo) {
      return res.status(422).json({ success: false, message: 'WhatsApp no está activo para esta clínica.' });
    }

    const r = await callGateway('POST', '/wa/enviar', {
      tenantId       : t.id,
      telefono,
      mensaje        : mensaje || null,
      imagen_base64  : imagen_base64 || null,
      imagen_mimetype: imagen_mimetype || null,
      propietarioId  : propietario_id || null,
      tipo           : 'manual',
      codigoPais     : cfg.codigo_pais || '+51',
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

// ══════════════════════════════════════════════════════════════
// CAMPAÑAS v3
// ══════════════════════════════════════════════════════════════

// GET /api/v1/wa/campanas
router.get('/campanas', authorize('admin'), async (req, res, next) => {
  try {
    const { estado } = req.query;
    let sql = 'SELECT * FROM wa_campanas WHERE 1=1';
    const params = [];
    if (estado) { sql += ' AND estado=?'; params.push(estado); }
    sql += ' ORDER BY created_at DESC';
    const rows = await req.db.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/v1/wa/campanas/proyeccion
router.get('/campanas/proyeccion', authorize('admin'), async (req, res, next) => {
  try {
    const { segmento = 'todos', segmento_valor } = req.query;
    let sql = '';
    switch (segmento) {
      case 'todos':
        sql = "SELECT COUNT(DISTINCT id) AS total FROM propietarios WHERE telefono IS NOT NULL AND telefono != ''";
        break;
      case 'por_especie':
        sql = `SELECT COUNT(DISTINCT p.id) AS total FROM propietarios p JOIN mascotas m ON m.propietario_id=p.id WHERE m.especie='${req.db.escape(segmento_valor||'perro').replace(/'/g,"'")}' AND p.telefono IS NOT NULL`;
        break;
      case 'vacunas_vencidas':
        sql = "SELECT COUNT(DISTINCT p.id) AS total FROM propietarios p JOIN mascotas m ON m.propietario_id=p.id JOIN vacunas v ON v.mascota_id=m.id WHERE v.proxima_dosis < CURDATE() AND p.telefono IS NOT NULL";
        break;
      case 'sin_citas_60d':
        sql = "SELECT COUNT(DISTINCT p.id) AS total FROM propietarios p WHERE p.id NOT IN (SELECT DISTINCT mascota_id FROM citas WHERE fecha_hora >= DATE_SUB(NOW(),INTERVAL 60 DAY)) AND p.telefono IS NOT NULL";
        break;
      default:
        sql = "SELECT COUNT(DISTINCT id) AS total FROM propietarios WHERE telefono IS NOT NULL AND telefono != ''";
    }
    const [row] = await req.db.query(sql);
    return res.json({ success: true, data: { total: parseInt(row.total) || 0 } });
  } catch (err) { next(err); }
});

// GET /api/v1/wa/campanas/:id
router.get('/campanas/:id', authorize('admin'), async (req, res, next) => {
  try {
    const [c] = await req.db.query('SELECT * FROM wa_campanas WHERE id=?', [req.params.id]);
    if (!c) return res.status(404).json({ success: false, message: 'Campaña no encontrada.' });
    return res.json({ success: true, data: c });
  } catch (err) { next(err); }
});

// GET /api/v1/wa/campanas/:id/contactos
router.get('/campanas/:id/contactos', authorize('admin'), async (req, res, next) => {
  try {
    const { estado, limit = 100, offset = 0 } = req.query;
    let sql = `SELECT wcc.id, wcc.propietario_id, wcc.telefono, wcc.nombre,
                      wcc.estado, wcc.error, wcc.enviado_at,
                      CONCAT(p.nombre,' ',p.apellido) AS prop_nombre_completo
               FROM wa_campana_contactos wcc
               LEFT JOIN propietarios p ON p.id = wcc.propietario_id
               WHERE wcc.campana_id = ?`;
    const params = [req.params.id];
    if (estado) { sql += ' AND wcc.estado = ?'; params.push(estado); }
    sql += ` ORDER BY wcc.id ASC LIMIT ${parseInt(limit) || 100} OFFSET ${parseInt(offset) || 0}`;

    const [rows] = await req.db.execute(sql, params);

    const [[{ total }]] = await req.db.execute(
      'SELECT COUNT(*) AS total FROM wa_campana_contactos WHERE campana_id = ?', [req.params.id]
    );
    const [[{ enviados }]] = await req.db.execute(
      "SELECT COUNT(*) AS enviados FROM wa_campana_contactos WHERE campana_id = ? AND estado = 'enviado'", [req.params.id]
    );
    const [[{ fallidos }]] = await req.db.execute(
      "SELECT COUNT(*) AS fallidos FROM wa_campana_contactos WHERE campana_id = ? AND estado = 'fallido'", [req.params.id]
    );

    return res.json({ success: true, data: rows, meta: { total, enviados, fallidos } });
  } catch (err) { next(err); }
});

// POST /api/v1/wa/campanas
router.post('/campanas', authorize('admin'), async (req, res, next) => {
  try {
    const { nombre, mensaje, segmento = 'todos', segmento_valor, imagen_url, imagen_blob_name, estado = 'borrador', programada_at } = req.body;
    console.log('[CAMPANA POST] imagen_url:', imagen_url, '| imagen_blob_name:', imagen_blob_name);
    if (!nombre || !mensaje) return res.status(422).json({ success: false, message: 'Nombre y mensaje requeridos.' });
    const result = await req.db.query(
      `INSERT INTO wa_campanas (nombre, mensaje, segmento, segmento_valor, imagen_url, imagen_blob_name, estado, programada_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [nombre, mensaje, segmento, segmento_valor || null, imagen_url || null, imagen_blob_name || null,
       estado, programada_at || null]
    );
    return res.status(201).json({ success: true, data: { id: result.insertId }, message: 'Campaña creada.' });
  } catch (err) { next(err); }
});

// PUT /api/v1/wa/campanas/:id
router.put('/campanas/:id', authorize('admin'), async (req, res, next) => {
  try {
    const { nombre, mensaje, segmento, segmento_valor, imagen_url, imagen_blob_name, estado } = req.body;
    await req.db.query(
      `UPDATE wa_campanas SET nombre=?, mensaje=?, segmento=?, segmento_valor=?,
        imagen_url=?, imagen_blob_name=?, estado=? WHERE id=?`,
      [nombre, mensaje, segmento || 'todos', segmento_valor || null,
       imagen_url || null, imagen_blob_name || null, estado || 'borrador', req.params.id]
    );
    return res.json({ success: true, message: 'Campaña actualizada.' });
  } catch (err) { next(err); }
});

// POST /api/v1/wa/campanas/:id/:accion
router.post('/campanas/:id/:accion', authorize('admin'), async (req, res, next) => {
  try {
    const { id, accion } = req.params;
    const acciones = {
      pausar   : "UPDATE wa_campanas SET estado='pausada', pausada_at=NOW() WHERE id=?",
      reanudar : "UPDATE wa_campanas SET estado='enviando' WHERE id=?",
      iniciar  : "UPDATE wa_campanas SET estado='enviando', iniciada_at=NOW() WHERE id=?",
      cancelar : "UPDATE wa_campanas SET estado='cancelada' WHERE id=?",
    };
    if (!acciones[accion]) return res.status(422).json({ success: false, message: 'Acción inválida.' });
    await req.db.query(acciones[accion], [id]);
    const msgs = { pausar:'Campaña pausada.', reanudar:'Campaña reanudada.', iniciar:'Campaña iniciada.', cancelar:'Campaña cancelada.' };
    return res.json({ success: true, message: msgs[accion] });
  } catch (err) { next(err); }
});

// POST /api/v1/wa/upload — proxy al gateway
router.post('/upload', authorize('admin'), async (req, res, next) => {
  try {
    const tenant = await getTenantInfo(req);
    const result = await callGateway('POST', '/wa/upload', {
      tenantId   : tenant?.id,
      base64     : req.body.base64,
      contentType: req.body.contentType,
      filename   : req.body.filename,
    });
    if (!result.data?.success) return res.status(500).json(result.data || { success: false });
    return res.json(result.data);
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════
// HISTORIAS v3
// ══════════════════════════════════════════════════════════════

// GET /api/v1/wa/historias
router.get('/historias', authorize('admin'), async (req, res, next) => {
  try {
    const { estado } = req.query;
    let sql = 'SELECT h.*, u.nombre AS creada_por_nombre FROM wa_historias h JOIN usuarios u ON u.id=h.creada_por_id WHERE 1=1';
    const params = [];
    if (estado) { sql += ' AND h.estado=?'; params.push(estado); }
    sql += ' ORDER BY h.created_at DESC';
    const rows = await req.db.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/v1/wa/historias/:id
router.get('/historias/:id', authorize('admin'), async (req, res, next) => {
  try {
    const [h] = await req.db.query('SELECT * FROM wa_historias WHERE id=?', [req.params.id]);
    if (!h) return res.status(404).json({ success: false, message: 'Historia no encontrada.' });
    return res.json({ success: true, data: h });
  } catch (err) { next(err); }
});

// POST /api/v1/wa/historias
router.post('/historias', authorize('admin'), async (req, res, next) => {
  try {
    const { titulo, tipo = 'imagen', texto, imagen_url, imagen_blob, estado = 'borrador', programada_at, publicar_ahora } = req.body;

    // titulo fallback si viene vacío
    const tituloFinal = titulo?.trim() ||
      (texto ? texto.substring(0, 60) : null) ||
      ('Historia ' + new Date().toLocaleDateString('es-PE'));

    // Estado: si publicar_ahora → borrador (el gateway lo pone en publicada al terminar)
    //         si programada_at → programada
    //         si no → borrador
    const estadoFinal = publicar_ahora ? 'borrador'
      : (programada_at ? 'programada' : (estado || 'borrador'));

    const result = await req.db.query(
      `INSERT INTO wa_historias (titulo, tipo, texto, imagen_url, imagen_blob, estado, programada_at, creada_por_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [tituloFinal, tipo, texto || null, imagen_url || null, imagen_blob || null,
       estadoFinal, programada_at || null, req.user.id]
    );

    const historiaId = result.insertId;

    // Publicar inmediatamente si se solicitó
    if (publicar_ahora) {
      const tenant = await getTenantInfo(req);
      if (tenant) {
        callGateway('POST', '/wa/historia/publicar', {
          tenantId : tenant.id,
          historiaId,
          imagenUrl: imagen_url || null,
          texto    : texto || null,
        }).catch(e => console.error('[WA Historia publicar]', e.message));
      }
    }

    return res.status(201).json({ success: true, data: { id: historiaId }, message: publicar_ahora ? 'Historia publicando…' : 'Historia guardada.' });
  } catch (err) { next(err); }
});

// PUT /api/v1/wa/historias/:id
router.put('/historias/:id', authorize('admin'), async (req, res, next) => {
  try {
    const { titulo, tipo, texto, imagen_url, imagen_blob, estado, programada_at } = req.body;
    const tituloFinal = titulo?.trim() ||
      (texto ? texto.substring(0, 60) : null) ||
      ('Historia ' + new Date().toLocaleDateString('es-PE'));
    const estadoFinal = programada_at ? 'programada' : (estado || 'borrador');

    await req.db.query(
      `UPDATE wa_historias SET titulo=?, tipo=?, texto=?, imagen_url=?, imagen_blob=?, estado=?, programada_at=? WHERE id=?`,
      [tituloFinal, tipo || 'imagen', texto || null, imagen_url || null, imagen_blob || null,
       estadoFinal, programada_at || null, req.params.id]
    );
    return res.json({ success: true, message: 'Historia actualizada.' });
  } catch (err) { next(err); }
});

// POST /api/v1/wa/historias/:id/publicar
router.post('/historias/:id/publicar', authorize('admin'), async (req, res, next) => {
  try {
    const [h] = await req.db.query('SELECT * FROM wa_historias WHERE id=?', [req.params.id]);
    if (!h) return res.status(404).json({ success: false, message: 'Historia no encontrada.' });
    const tenant = await getTenantInfo(req);
    const result = await callGateway('POST', '/wa/historia/publicar', {
      tenantId  : tenant?.id,
      historiaId: h.id,
      imagenUrl : h.imagen_url || null,
      texto     : h.texto || null,
    });
    if (!result.data?.success) return res.status(500).json(result.data || { success: false });
    return res.json({ success: true, message: 'Historia publicada.' });
  } catch (err) { next(err); }
});

// DELETE /api/v1/wa/campanas/:id
router.delete('/campanas/:id', authorize('admin'), async (req, res, next) => {
  try {
    const [c] = await req.db.query('SELECT imagen_blob_name FROM wa_campanas WHERE id=?', [req.params.id]);
    if (c?.imagen_blob_name) callGateway('DELETE', '/wa/upload/'+encodeURIComponent(c.imagen_blob_name)).catch(() => {});
    await req.db.query('DELETE FROM wa_campana_contactos WHERE campana_id=?', [req.params.id]);
    await req.db.query('DELETE FROM wa_campanas WHERE id=?', [req.params.id]);
    return res.json({ success: true, message: 'Campaña eliminada.' });
  } catch (err) { next(err); }
});

// DELETE /api/v1/wa/historias/:id
router.delete('/historias/:id', authorize('admin'), async (req, res, next) => {
  try {
    const [h] = await req.db.query('SELECT imagen_blob FROM wa_historias WHERE id=?', [req.params.id]);
    if (h?.imagen_blob) {
      callGateway('DELETE', '/wa/upload/'+encodeURIComponent(h.imagen_blob)).catch(() => {});
    }
    await req.db.query('DELETE FROM wa_historias WHERE id=?', [req.params.id]);
    return res.json({ success: true, message: 'Historia eliminada.' });
  } catch (err) { next(err); }
});

// ── GET /api/v1/wa/imagen/:campanaId — proxy seguro Azure ────────────────────────
// El navegador nunca llama directo a Azure. El backend descarga con SDK y hace pipe.
// Usa cliente singleton para no crear una conexión Azure por cada request.
router.get('/imagen/:campanaId', authenticate, async (req, res, next) => {
  try {
    const container = process.env.AZURE_WA_CONTAINER || 'wa-media';
    const azureClient = getWABlobClient();
    if (!azureClient) return res.status(503).json({ success: false, message: 'Azure no configurado' });

    const [campana] = await req.db.query(
      'SELECT imagen_url, imagen_blob_name FROM wa_campanas WHERE id = ?', [req.params.campanaId]
    );
    if (!campana || !campana.imagen_url) return res.status(404).end();

    // blobName: de imagen_blob_name guardado, o extraído de la URL
    let blobName = campana.imagen_blob_name;
    if (!blobName) {
      const urlParts = campana.imagen_url.split(`/${container}/`);
      blobName = urlParts[1] ? urlParts[1].split('?')[0] : null;
    }
    if (!blobName) return res.status(400).end();

    const blobClient = azureClient.getContainerClient(container).getBlobClient(blobName);
    const download   = await blobClient.download();

    const ext  = blobName.split('.').pop().toLowerCase();
    const mime = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp' };
    res.setHeader('Content-Type', download.contentType || mime[ext] || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600'); // 1h — imagen no cambia
    download.readableStreamBody.pipe(res);
  } catch (err) { next(err); }
});


// ── GET /api/v1/wa/imagen-historia/:historiaId — proxy Azure para historias ─────
router.get('/imagen-historia/:historiaId', authenticate, async (req, res, next) => {
  try {
    const container   = process.env.AZURE_WA_CONTAINER || 'wa-media';
    const azureClient = getWABlobClient();
    if (!azureClient) return res.status(503).json({ success: false, message: 'Azure no configurado' });

    const [h] = await req.db.query(
      'SELECT imagen_url, imagen_blob FROM wa_historias WHERE id = ?', [req.params.historiaId]
    );
    if (!h || !h.imagen_url) return res.status(404).end();

    let blobName = h.imagen_blob;
    if (!blobName) {
      const parts = h.imagen_url.split(`/${container}/`);
      blobName = parts[1] ? parts[1].split('?')[0] : null;
    }
    if (!blobName) return res.status(400).end();

    const blobClient = azureClient.getContainerClient(container).getBlobClient(blobName);
    const download   = await blobClient.download();

    const ext  = blobName.split('.').pop().toLowerCase();
    const mime = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp' };
    res.setHeader('Content-Type', download.contentType || mime[ext] || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    download.readableStreamBody.pipe(res);
  } catch (err) { next(err); }
});

module.exports = router;