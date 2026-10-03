'use strict';

/**
 * VetNetcodip — Exámenes en atenciones y seguimientos
 *
 * Maestra de exámenes = servicios_catalogo con categoría 'laboratorio' o 'imagenologia'.
 * Así el mismo examen se ve en: Servicios (pestaña Exámenes), Facturación, Atenciones y Seguimientos.
 *
 * Archivos: contenedor PRIVADO de Azure (AZURE_EXAMENES_CONTAINER, por defecto 'vet-examenes').
 *   - Se crea automáticamente (privado) en la primera subida.
 *   - Nunca se expone la URL de Azure: el backend hace pipe del archivo solo a usuarios logueados.
 *
 * Endpoints (todos con JWT):
 *   GET    /api/v1/examenes/catalogo                 → exámenes activos del catálogo
 *   GET    /api/v1/examenes?mascota_id=X             → exámenes de una mascota (con archivos)
 *   GET    /api/v1/examenes?historia_id=X            → exámenes de una atención (con archivos)
 *   POST   /api/v1/examenes                          → registrar examen en atención / seguimiento
 *   PUT    /api/v1/examenes/:id                      → editar observaciones
 *   DELETE /api/v1/examenes/:id                      → eliminar examen (y sus archivos)
 *   POST   /api/v1/examenes/:id/archivos             → subir 1 archivo (multipart, campo 'archivo')
 *   GET    /api/v1/examenes/archivos/:archivoId      → ver / descargar archivo (pipe)
 *   DELETE /api/v1/examenes/archivos/:archivoId      → eliminar archivo
 */

const { Router } = require('express');
const multer     = require('multer');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware }         = require('../middlewares/audit.middleware');
const logger                      = require('../config/logger');

const router = Router();
router.use(authenticate);

const CATEGORIAS_EXAMEN = ['laboratorio', 'imagenologia'];
const MAX_MB            = 10;
const MIME_PERMITIDOS   = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const ROLES_ELIMINAR    = ['admin', 'veterinario', 'veterinario_recepcionista'];

// ── Azure (contenedor privado) ────────────────────────────────────
let _azureClient    = null;
let _containerListo = false;

function getContainerName() {
  return process.env.AZURE_EXAMENES_CONTAINER || 'vet-examenes';
}

function getAzureClient() {
  if (_azureClient) return _azureClient;
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) return null;
  const { BlobServiceClient } = require('@azure/storage-blob');
  _azureClient = BlobServiceClient.fromConnectionString(connStr);
  return _azureClient;
}

async function getContainerClient() {
  const client = getAzureClient();
  if (!client) return null;
  const cont = client.getContainerClient(getContainerName());
  if (!_containerListo) {
    // Sin parámetro "access" → el contenedor se crea PRIVADO
    await cont.createIfNotExists();
    _containerListo = true;
  }
  return cont;
}

/** Borra blobs de Azure sin romper el flujo si alguno falla (best-effort). */
async function borrarBlobs(blobNames) {
  if (!blobNames || !blobNames.length) return;
  try {
    const cont = await getContainerClient();
    if (!cont) return;
    for (const name of blobNames) {
      try { await cont.getBlobClient(name).deleteIfExists(); }
      catch (e) { logger.warn('⚠️  No se pudo borrar blob ' + name + ': ' + e.message); }
    }
  } catch (e) {
    logger.warn('⚠️  Error borrando blobs de exámenes: ' + e.message);
  }
}

/**
 * Devuelve los blob_name de los archivos de exámenes de una atención o de un seguimiento.
 * Lo usa historia.routes.js ANTES de eliminar una atención / seguimiento,
 * para luego limpiar Azure (los registros se borran solos por FK CASCADE).
 */
async function obtenerBlobsExamenes(db, { historiaId = null, seguimientoId = null } = {}) {
  let sql = `SELECT a.blob_name
             FROM historia_examen_archivos a
             JOIN historia_examenes e ON e.id = a.examen_id
             WHERE 1=1`;
  const params = [];
  if (historiaId)    { sql += ' AND e.historia_id = ?';    params.push(historiaId); }
  if (seguimientoId) { sql += ' AND e.seguimiento_id = ?'; params.push(seguimientoId); }
  if (!params.length) return [];
  try {
    const rows = await db.query(sql, params);
    return rows.map(r => r.blob_name);
  } catch (e) {
    // Si la migración aún no se corrió en este tenant, no romper el borrado de la historia
    logger.warn('⚠️  obtenerBlobsExamenes: ' + e.message);
    return [];
  }
}

// ── Multer en memoria ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!MIME_PERMITIDOS.includes(file.mimetype)) {
      const err = new Error('Solo se permiten archivos PDF, JPG, PNG o WEBP.');
      err.status = 422;
      return cb(err);
    }
    cb(null, true);
  },
}).single('archivo');

function procesarUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload(req, res, (err) => {
      if (!err) return resolve();
      if (err.code === 'LIMIT_FILE_SIZE') {
        const e = new Error('El archivo supera el máximo de ' + MAX_MB + ' MB.');
        e.status = 422;
        return reject(e);
      }
      if (!err.status) err.status = 422;
      reject(err);
    });
  });
}

// ── Helper: adjuntar archivos a una lista de exámenes ─────────────
async function adjuntarArchivos(db, examenes) {
  if (!examenes.length) return examenes;
  const ids = examenes.map(e => e.id);
  const placeholders = ids.map(() => '?').join(',');
  const archivos = await db.query(
    `SELECT id, examen_id, nombre_original, mime_type, tamano_bytes, created_at
     FROM historia_examen_archivos
     WHERE examen_id IN (${placeholders})
     ORDER BY created_at ASC`, ids
  );
  const porExamen = {};
  archivos.forEach(a => { (porExamen[a.examen_id] = porExamen[a.examen_id] || []).push(a); });
  examenes.forEach(e => { e.archivos = porExamen[e.id] || []; });
  return examenes;
}

// ══════════════════════════════════════════════════════════════════
// CATÁLOGO
// ══════════════════════════════════════════════════════════════════

// GET /api/v1/examenes/catalogo
router.get('/catalogo', async (req, res, next) => {
  try {
    const rows = await req.db.query(
      `SELECT id, nombre, categoria, precio, descripcion
       FROM servicios_catalogo
       WHERE activo = 1 AND categoria IN ('laboratorio','imagenologia')
       ORDER BY categoria, nombre`
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// ARCHIVOS  (van antes de '/:id' para que Express no los confunda)
// ══════════════════════════════════════════════════════════════════

// GET /api/v1/examenes/archivos/:archivoId — pipe desde Azure
router.get('/archivos/:archivoId', async (req, res, next) => {
  try {
    const [arch] = await req.db.query(
      'SELECT blob_name, nombre_original, mime_type FROM historia_examen_archivos WHERE id = ?',
      [req.params.archivoId]
    );
    if (!arch) return res.status(404).json({ success: false, message: 'Archivo no encontrado.' });

    const cont = await getContainerClient();
    if (!cont) return res.status(500).json({ success: false, message: 'Azure Storage no configurado.' });

    const download = await cont.getBlobClient(arch.blob_name).download();
    const nombre   = encodeURIComponent(arch.nombre_original || 'archivo');

    res.setHeader('Content-Type', arch.mime_type || download.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', "inline; filename*=UTF-8''" + nombre);
    res.setHeader('Cache-Control', 'private, max-age=300');
    download.readableStreamBody.pipe(res);
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ success: false, message: 'El archivo ya no existe en el almacenamiento.' });
    }
    next(err);
  }
});

// DELETE /api/v1/examenes/archivos/:archivoId
router.delete('/archivos/:archivoId', authorize(...ROLES_ELIMINAR), async (req, res, next) => {
  try {
    const [arch] = await req.db.query(
      'SELECT id, blob_name FROM historia_examen_archivos WHERE id = ?',
      [req.params.archivoId]
    );
    if (!arch) return res.status(404).json({ success: false, message: 'Archivo no encontrado.' });

    await req.db.query('DELETE FROM historia_examen_archivos WHERE id = ?', [arch.id]);
    borrarBlobs([arch.blob_name]); // fire & forget
    return res.json({ success: true, message: 'Archivo eliminado.' });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// EXÁMENES
// ══════════════════════════════════════════════════════════════════

// GET /api/v1/examenes?mascota_id=X  |  ?historia_id=X
router.get('/', async (req, res, next) => {
  try {
    const { mascota_id, historia_id } = req.query;
    if (!mascota_id && !historia_id) {
      return res.status(422).json({ success: false, message: 'mascota_id o historia_id requerido.' });
    }
    let sql = `SELECT e.*, u.nombre AS registrado_por_nombre
               FROM historia_examenes e
               JOIN usuarios u ON u.id = e.registrado_por_id
               WHERE 1=1`;
    const params = [];
    if (mascota_id)  { sql += ' AND e.mascota_id = ?';  params.push(mascota_id); }
    if (historia_id) { sql += ' AND e.historia_id = ?'; params.push(historia_id); }
    sql += ' ORDER BY e.fecha DESC, e.id DESC';

    const examenes = await req.db.query(sql, params);
    await adjuntarArchivos(req.db, examenes);
    return res.json({ success: true, data: examenes });
  } catch (err) { next(err); }
});

// POST /api/v1/examenes
// body: { historia_id, seguimiento_id?, servicio_id, observaciones?, fecha? }
router.post('/', auditMiddleware('historia_clinica:actualizado', 'historia_clinica'), async (req, res, next) => {
  try {
    const { historia_id, seguimiento_id, servicio_id, observaciones, fecha } = req.body;

    if (!historia_id || !servicio_id) {
      return res.status(422).json({ success: false, message: 'historia_id y servicio_id son requeridos.' });
    }

    const [historia] = await req.db.query(
      'SELECT id, mascota_id, fecha FROM historia_clinica WHERE id = ?', [historia_id]
    );
    if (!historia) return res.status(404).json({ success: false, message: 'Atención no encontrada.' });

    let fechaExamen = fecha || null;
    if (seguimiento_id) {
      const [seg] = await req.db.query(
        'SELECT id, fecha FROM historia_seguimientos WHERE id = ? AND historia_id = ?',
        [seguimiento_id, historia_id]
      );
      if (!seg) return res.status(404).json({ success: false, message: 'Seguimiento no encontrado.' });
      if (!fechaExamen) fechaExamen = seg.fecha; // por defecto, la fecha del seguimiento
    }

    const [svc] = await req.db.query(
      'SELECT id, nombre, categoria FROM servicios_catalogo WHERE id = ?', [servicio_id]
    );
    if (!svc) return res.status(404).json({ success: false, message: 'Examen no encontrado en el catálogo.' });
    if (!CATEGORIAS_EXAMEN.includes(svc.categoria)) {
      return res.status(422).json({ success: false, message: 'El servicio seleccionado no es un examen.' });
    }

    const result = await req.db.query(
      `INSERT INTO historia_examenes
         (historia_id, seguimiento_id, mascota_id, servicio_id, nombre_examen, categoria,
          fecha, observaciones, registrado_por_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [historia.id, seguimiento_id || null, historia.mascota_id, svc.id, svc.nombre, svc.categoria,
       fechaExamen || historia.fecha || new Date(), observaciones?.trim() || null, req.user.id]
    );

    return res.status(201).json({
      success: true,
      message: 'Examen registrado.',
      data   : { id: result.insertId, nombre_examen: svc.nombre },
    });
  } catch (err) { next(err); }
});

// PUT /api/v1/examenes/:id  — editar observaciones
router.put('/:id', auditMiddleware('historia_clinica:actualizado', 'historia_clinica'), async (req, res, next) => {
  try {
    const { observaciones } = req.body;
    const [ex] = await req.db.query('SELECT id FROM historia_examenes WHERE id = ?', [req.params.id]);
    if (!ex) return res.status(404).json({ success: false, message: 'Examen no encontrado.' });

    await req.db.query(
      'UPDATE historia_examenes SET observaciones = ? WHERE id = ?',
      [observaciones?.trim() || null, req.params.id]
    );
    return res.json({ success: true, message: 'Examen actualizado.' });
  } catch (err) { next(err); }
});

// DELETE /api/v1/examenes/:id — elimina examen + archivos (BD por CASCADE, Azure aquí)
router.delete('/:id', authorize(...ROLES_ELIMINAR),
  auditMiddleware('historia_clinica:actualizado', 'historia_clinica'),
  async (req, res, next) => {
    try {
      const [ex] = await req.db.query('SELECT id FROM historia_examenes WHERE id = ?', [req.params.id]);
      if (!ex) return res.status(404).json({ success: false, message: 'Examen no encontrado.' });

      const archivos = await req.db.query(
        'SELECT blob_name FROM historia_examen_archivos WHERE examen_id = ?', [ex.id]
      );
      await req.db.query('DELETE FROM historia_examenes WHERE id = ?', [ex.id]);
      borrarBlobs(archivos.map(a => a.blob_name)); // fire & forget
      return res.json({ success: true, message: 'Examen eliminado.' });
    } catch (err) { next(err); }
  }
);

// POST /api/v1/examenes/:id/archivos — multipart, campo 'archivo'
router.post('/:id/archivos', async (req, res, next) => {
  try {
    const [ex] = await req.db.query('SELECT id FROM historia_examenes WHERE id = ?', [req.params.id]);
    if (!ex) return res.status(404).json({ success: false, message: 'Examen no encontrado.' });

    await procesarUpload(req, res);
    if (!req.file) return res.status(422).json({ success: false, message: 'No se recibió ningún archivo.' });

    const cont = await getContainerClient();
    if (!cont) return res.status(500).json({ success: false, message: 'Azure Storage no configurado.' });

    const tenant   = req.tenant?.slug || 'default';
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
    const blobName = tenant + '/examenes/' + ex.id + '/' + Date.now() + '_' + safeName;

    await cont.getBlockBlobClient(blobName).uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype },
    });

    const result = await req.db.query(
      `INSERT INTO historia_examen_archivos
         (examen_id, blob_name, nombre_original, mime_type, tamano_bytes, subido_por_id)
       VALUES (?,?,?,?,?,?)`,
      [ex.id, blobName, req.file.originalname.slice(0, 255), req.file.mimetype, req.file.size, req.user.id]
    );

    return res.status(201).json({
      success: true,
      message: 'Archivo subido.',
      data   : {
        id             : result.insertId,
        nombre_original: req.file.originalname,
        mime_type      : req.file.mimetype,
        tamano_bytes   : req.file.size,
      },
    });
  } catch (err) {
    if (err.status === 422) return res.status(422).json({ success: false, message: err.message });
    next(err);
  }
});

module.exports = router;
module.exports.obtenerBlobsExamenes = obtenerBlobsExamenes;
module.exports.borrarBlobsExamenes  = borrarBlobs;