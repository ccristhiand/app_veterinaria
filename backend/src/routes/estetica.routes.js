'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');

const router = Router();
router.use(authenticate);

// ── GET /api/v1/estetica ─────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { mascota_id, fecha } = req.query;
    let sql = `SELECT s.*, m.nombre AS mascota_nombre, m.especie,
                      CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
                      u.nombre AS atendido_por_nombre
               FROM servicios_estetica s
               JOIN mascotas m ON m.id = s.mascota_id
               JOIN propietarios p ON p.id = m.propietario_id
               JOIN usuarios u ON u.id = s.atendido_por_id
               WHERE 1=1`;
    const params = [];
    if (mascota_id) { sql += ' AND s.mascota_id = ?'; params.push(mascota_id); }
    if (fecha)      { sql += ' AND s.fecha = ?';      params.push(fecha); }
    sql += ' ORDER BY s.fecha DESC, s.created_at DESC';
    const rows = await req.db.query(sql, params);

    // Cargar fotos de cada servicio
    for (const s of rows) {
      s.fotos = await req.db.query(
        'SELECT * FROM estetica_fotos WHERE estetica_id = ? ORDER BY momento, created_at ASC',
        [s.id]
      );
    }

    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/v1/estetica/:id ──────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const [s] = await req.db.query(
      `SELECT s.*, m.nombre AS mascota_nombre, m.especie,
              CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
              u.nombre AS atendido_por_nombre
       FROM servicios_estetica s
       JOIN mascotas m ON m.id = s.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       JOIN usuarios u ON u.id = s.atendido_por_id
       WHERE s.id = ?`, [req.params.id]
    );
    if (!s) return res.status(404).json({ success: false, message: 'Servicio no encontrado.' });
    s.fotos = await req.db.query(
      'SELECT * FROM estetica_fotos WHERE estetica_id = ? ORDER BY momento, created_at ASC',
      [s.id]
    );
    return res.json({ success: true, data: s });
  } catch (err) { next(err); }
});

// ── POST /api/v1/estetica ─────────────────────────────────────────
router.post('/', auditMiddleware('estetica:creado', 'estetica'), async (req, res, next) => {
  try {
    const { mascota_id, cita_id, fecha, tipo_bano, incluye_corte, incluye_unas,
            incluye_dental, productos, precio, observaciones } = req.body;
    if (!mascota_id || !fecha)
      return res.status(422).json({ success: false, message: 'mascota_id y fecha requeridos.' });
    const result = await req.db.query(
      `INSERT INTO servicios_estetica
         (mascota_id, atendido_por_id, cita_id, fecha, tipo_bano,
          incluye_corte, incluye_unas, incluye_dental, productos, precio, observaciones)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [mascota_id, req.user.id, cita_id||null, fecha, tipo_bano||'basico',
       incluye_corte?1:0, incluye_unas?1:0, incluye_dental?1:0,
       productos||null, precio||null, observaciones||null]
    );
    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) { next(err); }
});

// ── PUT /api/v1/estetica/:id ──────────────────────────────────────
router.put('/:id', auditMiddleware('estetica:actualizado', 'estetica'), async (req, res, next) => {
  try {
    const { fecha, tipo_bano, incluye_corte, incluye_unas,
            incluye_dental, productos, precio, observaciones } = req.body;
    await req.db.query(
      `UPDATE servicios_estetica SET fecha=?, tipo_bano=?, incluye_corte=?,
        incluye_unas=?, incluye_dental=?, productos=?, precio=?, observaciones=?
       WHERE id=?`,
      [fecha, tipo_bano||'basico', incluye_corte?1:0, incluye_unas?1:0,
       incluye_dental?1:0, productos||null, precio||null, observaciones||null, req.params.id]
    );
    return res.json({ success: true, message: 'Servicio actualizado.' });
  } catch (err) { next(err); }
});

// ── POST /api/v1/estetica/upload — sube foto via backend a Azure ──
// El navegador manda la foto como multipart/form-data al backend
// El backend la sube a Azure y devuelve la URL pública
router.post('/upload', async (req, res, next) => {
  try {
    const { BlobServiceClient } = require('@azure/storage-blob');
    const multer = require('multer');

    const connStr   = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const container = process.env.AZURE_STORAGE_CONTAINER || 'vet-fotos';

    if (!connStr) return res.status(500).json({ success: false, message: 'Azure Storage no configurado.' });

    // Usar multer en memoria para procesar el archivo
    const upload = multer({
      storage: multer.memoryStorage(),
      limits : { fileSize: 10 * 1024 * 1024 }, // 10MB máximo
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          return cb(new Error('Solo se permiten imágenes.'));
        }
        cb(null, true);
      },
    }).single('foto');

    // Procesar el archivo con multer
    await new Promise((resolve, reject) => {
      upload(req, res, (err) => { if (err) reject(err); else resolve(); });
    });

    if (!req.file) return res.status(422).json({ success: false, message: 'No se recibió ningún archivo.' });

    const tenant   = req.tenant?.slug || 'default';
    const fecha    = new Date().toISOString().split('T')[0];
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blobName = `${tenant}/${fecha}/${Date.now()}_${safeName}`;

    // Subir a Azure desde el backend
    const client    = BlobServiceClient.fromConnectionString(connStr);
    const contClient = client.getContainerClient(container);
    const blobClient = contClient.getBlockBlobClient(blobName);

    await blobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype },
    });

    const parts       = Object.fromEntries(connStr.split(';').map(p => { const [k,...v] = p.split('='); return [k, v.join('=')]; }));
    const accountName = parts.AccountName;
    const publicUrl   = `https://${accountName}.blob.core.windows.net/${container}/${blobName}`;

    return res.json({
      success: true,
      data: { public_url: publicUrl, blob_name: blobName },
    });
  } catch (err) { next(err); }
});


// ── GET /api/v1/estetica/foto/:fotoId — sirve foto via SAS temporal ──
// El navegador nunca ve la URL real de Azure
router.get('/foto/:fotoId', async (req, res, next) => {
  try {
    const { generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');

    const connStr   = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const container = process.env.AZURE_STORAGE_CONTAINER || 'vet-fotos';

    if (!connStr) return res.status(500).json({ success: false, message: 'Azure Storage no configurado.' });

    // Obtener la URL del blob desde la BD
    const [foto] = await req.db.query(
      'SELECT url, nombre_archivo FROM estetica_fotos WHERE id = ?', [req.params.fotoId]
    );
    if (!foto) return res.status(404).json({ success: false, message: 'Foto no encontrada.' });

    // Extraer nombre del blob de la URL
    const parts       = Object.fromEntries(connStr.split(';').map(p => { const [k,...v] = p.split('='); return [k, v.join('=')]; }));
    const accountName = parts.AccountName;
    const accountKey  = parts.AccountKey;

    // blobName = todo lo que viene después de /{container}/
    const blobName = foto.url.split(`/${container}/`)[1];
    if (!blobName) return res.status(400).json({ success: false, message: 'URL de blob inválida.' });

    // Generar SAS Token válido 5 minutos — solo lectura
    const cred   = new StorageSharedKeyCredential(accountName, accountKey);
    const expiry = new Date(Date.now() + 5 * 60 * 1000);
    const sas    = generateBlobSASQueryParameters(
      {
        containerName: container,
        blobName,
        permissions  : BlobSASPermissions.parse('r'), // solo lectura
        expiresOn    : expiry,
      },
      cred
    ).toString();

    const sasUrl = `https://${accountName}.blob.core.windows.net/${container}/${blobName}?${sas}`;

    // Redirigir al SAS URL temporal — el navegador descarga la foto de Azure directamente
    // pero con una URL que expira en 5 min y no revela la URL base
    return res.redirect(302, sasUrl);
  } catch (err) { next(err); }
});

// ── POST /api/v1/estetica/:id/fotos — guardar URL de foto ─────────
router.post('/:id/fotos', async (req, res, next) => {
  try {
    const { momento, url, nombre_archivo } = req.body;

    if (!['antes','despues'].includes(momento))
      return res.status(422).json({ success: false, message: 'momento debe ser "antes" o "despues".' });
    if (!url)
      return res.status(422).json({ success: false, message: 'url requerida.' });

    const [existe] = await req.db.query('SELECT id FROM servicios_estetica WHERE id = ?', [req.params.id]);
    if (!existe) return res.status(404).json({ success: false, message: 'Servicio no encontrado.' });

    const result = await req.db.query(
      'INSERT INTO estetica_fotos (estetica_id, momento, url, nombre_archivo) VALUES (?,?,?,?)',
      [req.params.id, momento, url, nombre_archivo || null]
    );

    return res.status(201).json({
      success: true,
      message: 'Foto guardada.',
      data: { id: result.insertId, url, momento },
    });
  } catch (err) { next(err); }
});

// ── DELETE /api/v1/estetica/fotos/:fotoId — eliminar foto ─────────
router.delete('/fotos/:fotoId', authorize('admin', 'veterinario'), async (req, res, next) => {
  try {
    const [foto] = await req.db.query('SELECT * FROM estetica_fotos WHERE id = ?', [req.params.fotoId]);
    if (!foto) return res.status(404).json({ success: false, message: 'Foto no encontrada.' });

    // Opcional: eliminar de Azure también
    try {
      const { BlobServiceClient } = require('@azure/storage-blob');
      const connStr   = process.env.AZURE_STORAGE_CONNECTION_STRING;
      const container = process.env.AZURE_STORAGE_CONTAINER || 'vet-fotos';
      if (connStr && foto.nombre_archivo) {
        const client = BlobServiceClient.fromConnectionString(connStr);
        const tenant = req.tenant?.slug || 'default';
        await client.getContainerClient(container).deleteBlob(foto.url.split(`/${container}/`)[1]).catch(() => {});
      }
    } catch {}

    await req.db.query('DELETE FROM estetica_fotos WHERE id = ?', [req.params.fotoId]);
    return res.json({ success: true, message: 'Foto eliminada.' });
  } catch (err) { next(err); }
});

module.exports = router;