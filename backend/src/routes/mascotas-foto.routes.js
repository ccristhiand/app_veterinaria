'use strict';

/**
 * VetNetcodip — Foto de perfil de la mascota
 *
 * Se monta en /api/v1/mascotas (junto a mascotas.routes.js; no chocan porque
 * estas rutas terminan en /foto).
 *
 * Archivos: contenedor PRIVADO de Azure (AZURE_MASCOTAS_CONTAINER, por defecto 'vet-mascotas').
 *   - Se crea solo (privado) en la primera subida.
 *   - La imagen se sirve por el backend solo a usuarios logueados (no se expone la URL de Azure).
 *
 * Endpoints (JWT):
 *   GET    /api/v1/mascotas/:id/foto   → imagen (pipe)
 *   POST   /api/v1/mascotas/:id/foto   → subir / reemplazar (multipart, campo 'foto')
 *   DELETE /api/v1/mascotas/:id/foto   → quitar foto (vuelve el emoji)
 */

const { Router } = require('express');
const multer     = require('multer');
const { authenticate }    = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');
const logger              = require('../config/logger');

const router = Router();
router.use(authenticate);

const MAX_MB          = 5;
const MIME_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];

// ── Azure (contenedor privado) ────────────────────────────────────
let _azureClient    = null;
let _containerListo = false;

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
  const cont = client.getContainerClient(process.env.AZURE_MASCOTAS_CONTAINER || 'vet-mascotas');
  if (!_containerListo) {
    await cont.createIfNotExists(); // sin "access" → privado
    _containerListo = true;
  }
  return cont;
}

/** Borra el blob de una foto (best-effort, no rompe el flujo). */
async function borrarFotoBlob(blobName) {
  if (!blobName) return;
  try {
    const cont = await getContainerClient();
    if (cont) await cont.getBlobClient(blobName).deleteIfExists();
  } catch (e) {
    logger.warn('⚠️  No se pudo borrar foto de mascota ' + blobName + ': ' + e.message);
  }
}

// ── Multer en memoria ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!MIME_PERMITIDOS.includes(file.mimetype)) {
      const err = new Error('Solo se permiten imágenes JPG, PNG o WEBP.');
      err.status = 422;
      return cb(err);
    }
    cb(null, true);
  },
}).single('foto');

function procesarUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload(req, res, (err) => {
      if (!err) return resolve();
      if (err.code === 'LIMIT_FILE_SIZE') {
        const e = new Error('La foto supera el máximo de ' + MAX_MB + ' MB.');
        e.status = 422;
        return reject(e);
      }
      if (!err.status) err.status = 422;
      reject(err);
    });
  });
}

/** Envía la imagen del blob al cliente (lo usa también el carnet público). */
async function pipeFotoMascota(res, blobName) {
  const cont = await getContainerClient();
  if (!cont) return res.status(500).json({ success: false, message: 'Azure Storage no configurado.' });
  try {
    const download = await cont.getBlobClient(blobName).download();
    res.setHeader('Content-Type', download.contentType || 'image/jpeg');
    // El frontend pide ?v=<foto_updated_at>, así que se puede cachear sin miedo
    res.setHeader('Cache-Control', 'private, max-age=86400');
    download.readableStreamBody.pipe(res);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ success: false, message: 'Foto no encontrada.' });
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════════

// GET /api/v1/mascotas/:id/foto
router.get('/:id/foto', async (req, res, next) => {
  try {
    const [m] = await req.db.query('SELECT foto_blob FROM mascotas WHERE id = ?', [req.params.id]);
    if (!m || !m.foto_blob) return res.status(404).json({ success: false, message: 'La mascota no tiene foto.' });
    await pipeFotoMascota(res, m.foto_blob);
  } catch (err) { next(err); }
});

// POST /api/v1/mascotas/:id/foto  (multipart, campo 'foto')
router.post('/:id/foto', async (req, res, next) => {
  try {
    const [m] = await req.db.query('SELECT id, foto_blob FROM mascotas WHERE id = ?', [req.params.id]);
    if (!m) return res.status(404).json({ success: false, message: 'Mascota no encontrada.' });

    await procesarUpload(req, res);
    if (!req.file) return res.status(422).json({ success: false, message: 'No se recibió ninguna imagen.' });

    const cont = await getContainerClient();
    if (!cont) return res.status(500).json({ success: false, message: 'Azure Storage no configurado.' });

    const ext      = req.file.mimetype === 'image/png' ? 'png' : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg';
    const tenant   = req.tenant?.slug || 'default';
    const blobName = tenant + '/mascotas/' + m.id + '/' + Date.now() + '.' + ext;

    await cont.getBlockBlobClient(blobName).uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype },
    });

    const ahora = new Date();
    await req.db.query(
      'UPDATE mascotas SET foto_blob = ?, foto_updated_at = ? WHERE id = ?',
      [blobName, ahora, m.id]
    );

    if (m.foto_blob && m.foto_blob !== blobName) borrarFotoBlob(m.foto_blob); // la anterior, fire & forget

    return res.status(201).json({
      success: true,
      message: 'Foto actualizada.',
      data   : { foto_updated_at: ahora },
    });
  } catch (err) {
    if (err.status === 422) return res.status(422).json({ success: false, message: err.message });
    next(err);
  }
});

// DELETE /api/v1/mascotas/:id/foto
router.delete('/:id/foto', auditMiddleware('mascotas:actualizado', 'mascotas'), async (req, res, next) => {
  try {
    const [m] = await req.db.query('SELECT id, foto_blob FROM mascotas WHERE id = ?', [req.params.id]);
    if (!m) return res.status(404).json({ success: false, message: 'Mascota no encontrada.' });

    await req.db.query('UPDATE mascotas SET foto_blob = NULL, foto_updated_at = NULL WHERE id = ?', [m.id]);
    borrarFotoBlob(m.foto_blob);
    return res.json({ success: true, message: 'Foto eliminada.' });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.borrarFotoBlob  = borrarFotoBlob;
module.exports.pipeFotoMascota = pipeFotoMascota;