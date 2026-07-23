'use strict';

const { Router }   = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditLog, auditMiddleware, auditAuth } = require('../middlewares/audit.middleware');

const bcrypt         = require('bcrypt');
const createDOMPurify = require('dompurify');
const { JSDOM }       = require('jsdom');

// Sanitizador server-side para prevenir XSS
const _window    = new JSDOM('').window;
const DOMPurify_ = createDOMPurify(_window);
const sanitize   = html => DOMPurify_.sanitize(html || '', {
  FORCE_BODY  : true,
  ALLOWED_TAGS: ['div','p','span','h1','h2','h3','h4','h5','h6',
                 'table','thead','tbody','tr','th','td',
                 'ul','ol','li','strong','b','em','i','u','br',
                 'img','a','hr','mark','section','header','footer'],
  ALLOWED_ATTR: ['style','class','src','alt','href','target','id',
                 'width','height','align','border','cellpadding','cellspacing'],
  FORBID_TAGS : ['script','iframe','object','embed','form','input','button'],
  FORBID_ATTR : ['onerror','onload','onclick','onmouseover'],
});

// Helper para verificar password del admin antes de cambios sensibles
async function verificarPassword(req, res, password_confirm) {
  if (!password_confirm) {
    res.status(422).json({ success:false, message:'Debes confirmar tu contraseña para esta acción.' });
    return false;
  }
  const [usuario] = await req.db.query('SELECT password FROM usuarios WHERE id=?', [req.user.id]);
  const valido = await bcrypt.compare(password_confirm, usuario.password);
  if (!valido) {
    res.status(401).json({ success:false, message:'Contraseña incorrecta. Acción no autorizada.' });
    return false;
  }
  return true;
}

const router = Router();
router.use(authenticate);

// ── GET /api/v1/consentimientos/plantillas ───────────────────────
router.get('/plantillas', async (req, res, next) => {
  try {
    const rows = await req.db.query(
      'SELECT id, nombre, tipo, activo, created_at FROM consentimientos_plantillas ORDER BY nombre'
    );
    return res.json({ success:true, data:rows });
  } catch(err) { next(err); }
});

// ── GET /api/v1/consentimientos/plantillas/:id ───────────────────
router.get('/plantillas/:id', async (req, res, next) => {
  try {
    const [row] = await req.db.query('SELECT * FROM consentimientos_plantillas WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ success:false, message:'Plantilla no encontrada.' });
    return res.json({ success:true, data:row });
  } catch(err) { next(err); }
});

// ── POST /api/v1/consentimientos/plantillas ──────────────────────
router.post('/plantillas', authorize('admin'), async (req, res, next) => {
  try {
    const { nombre, tipo='procedimiento', contenido, password_confirm } = req.body;
    if (!nombre?.trim())    return res.status(422).json({ success:false, message:'Nombre requerido.' });
    if (!contenido?.trim()) return res.status(422).json({ success:false, message:'Contenido requerido.' });

    // Verificar password admin antes de guardar
    if (!await verificarPassword(req, res, password_confirm)) return;

    const result = await req.db.query(
      'INSERT INTO consentimientos_plantillas (nombre,tipo,contenido) VALUES (?,?,?)',
      [nombre.trim(), tipo, sanitize(contenido)]
    );
    return res.status(201).json({ success:true, data:{ id:result.insertId }, message:'Plantilla creada.' });
  } catch(err) { next(err); }
});

// ── PUT /api/v1/consentimientos/plantillas/:id ───────────────────
router.put('/plantillas/:id', authorize('admin'), async (req, res, next) => {
  try {
    const { nombre, tipo, contenido, activo, password_confirm } = req.body;

    // Verificar password admin antes de actualizar
    if (!await verificarPassword(req, res, password_confirm)) return;

    await req.db.query(
      'UPDATE consentimientos_plantillas SET nombre=?,tipo=?,contenido=?,activo=? WHERE id=?',
      [nombre, tipo, sanitize(contenido), activo?1:0, req.params.id]
    );
    return res.json({ success:true, message:'Plantilla actualizada.' });
  } catch(err) { next(err); }
});

// ── POST /api/v1/consentimientos/generar ─────────────────────────
// Genera un consentimiento llenado con los datos de la mascota
router.post('/generar', auditMiddleware('consentimientos:creado', 'consentimientos'), async (req, res, next) => {
  try {
    const { plantilla_id, mascota_id, veterinario_id } = req.body;
    if (!plantilla_id || !mascota_id)
      return res.status(422).json({ success:false, message:'plantilla_id y mascota_id requeridos.' });

    // Obtener datos
    const [plantilla] = await req.db.query('SELECT * FROM consentimientos_plantillas WHERE id=?', [plantilla_id]);
    if (!plantilla) return res.status(404).json({ success:false, message:'Plantilla no encontrada.' });

    const [mascota] = await req.db.query(
      `SELECT m.*, CONCAT(p.nombre,' ',p.apellido) AS nombre_propietario,
              p.dni AS dni_propietario, p.telefono, p.email, p.id AS propietario_id
       FROM mascotas m JOIN propietarios p ON p.id = m.propietario_id
       WHERE m.id=?`, [mascota_id]
    );
    if (!mascota) return res.status(404).json({ success:false, message:'Mascota no encontrada.' });

    const [vet] = await req.db.query(
      'SELECT nombre FROM usuarios WHERE id=?', [veterinario_id || req.user.id]
    );

    const [empresa] = await req.db.query('SELECT nombre, logo_url FROM empresa_config LIMIT 1');

    // Obtener nombre y logo del tenant desde vet_master
    const { masterQuery } = require('../config/masterDB');
    const host = req.headers['x-tenant-host'] || '';
    const [tenantConfig] = await masterQuery(
      `SELECT tc.nombre_clinica, tc.logo_url
       FROM tenants t
       JOIN tenant_config tc ON tc.tenant_id = t.id
       WHERE t.subdominio = ? LIMIT 1`, [host]
    ).catch(() => [null]);

    // Prioridad: tenant_config > empresa_config > default
    const nombreClinica = tenantConfig?.nombre_clinica || empresa?.nombre || 'VetClinic';
    const logoUrl       = tenantConfig?.logo_url || empresa?.logo_url || null;

    // HTML del logo para insertar en el documento
    const logoHtml = logoUrl
      ? `<img src="${logoUrl}" alt="${nombreClinica}" style="max-height:52px;max-width:52px;object-fit:contain;border-radius:.5rem"/>`
      : `<span style="font-size:1.6rem">🏥</span>`;

    // Reemplazar variables
    const hoy = new Date().toLocaleDateString('es-PE', { day:'2-digit', month:'long', year:'numeric' });
    let contenido = plantilla.contenido
      .replace(/{{nombre_mascota}}/g,    mascota.nombre || '')
      .replace(/{{especie}}/g,           mascota.especie || '')
      .replace(/{{raza}}/g,              mascota.raza || '')
      .replace(/{{peso_kg}}/g,           mascota.peso_kg || '')
      .replace(/{{nombre_propietario}}/g,mascota.nombre_propietario || '')
      .replace(/{{dni_propietario}}/g,   mascota.dni_propietario || '')
      .replace(/{{telefono}}/g,          mascota.telefono || '')
      .replace(/{{nombre_veterinario}}/g,vet?.nombre || req.user.nombre || '')
      .replace(/{{nombre_clinica}}/g,    nombreClinica)
      .replace(/{{logo_clinica}}/g,      logoHtml)
      .replace(/{{logo_url}}/g,          logoUrl || '')
      .replace(/{{fecha}}/g,             hoy);

    // Guardar en BD
    const result = await req.db.query(
      `INSERT INTO consentimientos_generados
         (plantilla_id, mascota_id, propietario_id, veterinario_id, contenido_final)
       VALUES (?,?,?,?,?)`,
      [plantilla_id, mascota_id, mascota.propietario_id, veterinario_id||req.user.id, contenido]
    );

    return res.json({
      success: true,
      data: { id:result.insertId, contenido, mascota, plantilla_nombre:plantilla.nombre },
      message: 'Consentimiento generado.',
    });
  } catch(err) { next(err); }
});

// ── GET /api/v1/consentimientos/historial ────────────────────────
router.get('/historial', async (req, res, next) => {
  try {
    const { mascota_id, page=1 } = req.query;
    const limit = 20, offset = (parseInt(page)-1)*limit;
    let sql = `SELECT cg.id, cg.created_at, cg.firmado, cg.firmado_at,
                      cp.nombre AS plantilla, cp.tipo,
                      m.nombre AS mascota, CONCAT(p.nombre,' ',p.apellido) AS propietario,
                      u.nombre AS veterinario
               FROM consentimientos_generados cg
               JOIN consentimientos_plantillas cp ON cp.id=cg.plantilla_id
               JOIN mascotas m ON m.id=cg.mascota_id
               JOIN propietarios p ON p.id=cg.propietario_id
               JOIN usuarios u ON u.id=cg.veterinario_id
               WHERE 1=1`;
    const params = [];
    if (mascota_id) { sql += ' AND cg.mascota_id=?'; params.push(mascota_id); }
    sql += ` ORDER BY cg.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    const rows = await req.db.query(sql, params);
    return res.json({ success:true, data:rows });
  } catch(err) { next(err); }
});

// ── GET /api/v1/consentimientos/:id ──────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const [row] = await req.db.query(
      `SELECT cg.*, cp.nombre AS plantilla_nombre, cp.tipo,
              m.nombre AS mascota, u.nombre AS veterinario
       FROM consentimientos_generados cg
       JOIN consentimientos_plantillas cp ON cp.id=cg.plantilla_id
       JOIN mascotas m ON m.id=cg.mascota_id
       JOIN usuarios u ON u.id=cg.veterinario_id
       WHERE cg.id=?`, [req.params.id]
    );
    if (!row) return res.status(404).json({ success:false, message:'No encontrado.' });
    return res.json({ success:true, data:row });
  } catch(err) { next(err); }
});

// ── PATCH /api/v1/consentimientos/:id/firmar ─────────────────────
router.patch('/:id/firmar', authorize('admin'), async (req, res, next) => {
  try {
    await req.db.query(
      "UPDATE consentimientos_generados SET firmado=1, firmado_at=NOW() WHERE id=?",
      [req.params.id]
    );
    return res.json({ success:true, message:'Consentimiento marcado como firmado.' });
  } catch(err) { next(err); }
});

module.exports = router;