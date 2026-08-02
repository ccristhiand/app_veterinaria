'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');

const router = Router();
router.use(authenticate);

// ── GET /api/v1/propietarios ──────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { search = '', page = 1, limit = 20 } = req.query;
    const limitN  = Math.min(parseInt(limit) || 20, 100);
    const offsetN = (Math.max(parseInt(page) || 1, 1) - 1) * limitN;
    const q = `%${search}%`;

    const rows = await req.db.query(
      `SELECT p.*, COUNT(m.id) AS total_mascotas
       FROM propietarios p
       LEFT JOIN mascotas m ON m.propietario_id = p.id
       WHERE p.nombre LIKE ? OR p.apellido LIKE ?
          OR p.dni LIKE ? OR p.telefono LIKE ?
          OR p.ruc LIKE ? OR p.razon_social LIKE ?
       GROUP BY p.id
       ORDER BY p.nombre, p.apellido
       LIMIT ${limitN} OFFSET ${offsetN}`,
      [q, q, q, q, q, q]
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/v1/propietarios/buscar-documento ─────────────────────
// Verifica si ya existe un propietario con ese DNI o RUC
// Usado para autocompletar y prevenir duplicados
router.get('/buscar-documento', async (req, res, next) => {
  try {
    const { tipo, numero } = req.query;
    if (!tipo || !numero)
      return res.status(422).json({ success: false, message: 'tipo y numero requeridos.' });

    let prop = null;
    if (tipo === 'DNI') {
      [prop] = await req.db.query(
        'SELECT id, nombre, apellido, dni, telefono, email, direccion FROM propietarios WHERE dni = ?',
        [numero.trim()]
      );
    } else if (tipo === 'RUC') {
      [prop] = await req.db.query(
        'SELECT id, nombre, apellido, ruc, razon_social, direccion_fiscal FROM propietarios WHERE ruc = ?',
        [numero.trim()]
      );
    }

    if (prop) {
      return res.json({
        success : true,
        existe  : true,
        data    : prop,
        message : 'Propietario ya registrado en el sistema.',
      });
    }

    return res.json({ success: true, existe: false });
  } catch (err) { next(err); }
});

// ── GET /api/v1/propietarios/:id ──────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const [prop] = await req.db.query('SELECT * FROM propietarios WHERE id = ?', [req.params.id]);
    if (!prop) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    const mascotas = await req.db.query(
      'SELECT id, nombre, especie, raza, sexo, peso_kg, alertas_medicas, fecha_nacimiento, microchip FROM mascotas WHERE propietario_id = ? ORDER BY nombre',
      [req.params.id]
    );
    return res.json({ success: true, data: { ...prop, mascotas } });
  } catch (err) { next(err); }
});

// ── POST /api/v1/propietarios ─────────────────────────────────────
router.post('/', auditMiddleware('propietarios:creado', 'propietarios'), async (req, res, next) => {
  try {
    const { nombre, apellido, tipo_documento = 'DNI', dni, telefono, email,
            direccion, ruc, razon_social, direccion_fiscal } = req.body;

    if (!nombre?.trim() || !apellido?.trim())
      return res.status(422).json({ success: false, message: 'Nombre y apellido son obligatorios.' });

    if (ruc && !/^\d{11}$/.test(ruc.trim()))
      return res.status(422).json({ success: false, message: 'El RUC debe tener 11 dígitos.' });

    if (dni && !/^\d{8}$/.test(dni.trim()))
      return res.status(422).json({ success: false, message: 'El DNI debe tener 8 dígitos.' });

    // Verificar duplicado por DNI
    if (dni?.trim()) {
      const [dup] = await req.db.query('SELECT id FROM propietarios WHERE dni = ?', [dni.trim()]);
      if (dup) return res.status(409).json({
        success: false,
        message: 'Ya existe un propietario con ese DNI.',
        code   : 'DNI_DUPLICADO',
        data   : { id: dup.id },
      });
    }

    // Verificar duplicado por RUC
    if (ruc?.trim()) {
      const [dup] = await req.db.query('SELECT id FROM propietarios WHERE ruc = ?', [ruc.trim()]);
      if (dup) return res.status(409).json({
        success: false,
        message: 'Ya existe un propietario con ese RUC.',
        code   : 'RUC_DUPLICADO',
        data   : { id: dup.id },
      });
    }

    const result = await req.db.query(
      `INSERT INTO propietarios
         (tipo_documento, nombre, apellido, dni, telefono, email,
          direccion, ruc, razon_social, direccion_fiscal)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [tipo_documento, nombre.trim(), apellido.trim(), dni?.trim()||null,
       telefono?.trim()||null, email?.trim()||null, direccion?.trim()||null,
       ruc?.trim()||null, razon_social?.trim()||null, direccion_fiscal?.trim()||null]
    );
    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) { next(err); }
});

// ── PUT /api/v1/propietarios/:id ──────────────────────────────────
router.put('/:id', auditMiddleware('propietarios:actualizado', 'propietarios'), async (req, res, next) => {
  try {
    const { nombre, apellido, tipo_documento = 'DNI', dni, telefono, email,
            direccion, ruc, razon_social, direccion_fiscal } = req.body;

    if (!nombre?.trim() || !apellido?.trim())
      return res.status(422).json({ success: false, message: 'Nombre y apellido son obligatorios.' });

    if (ruc && !/^\d{11}$/.test(ruc.trim()))
      return res.status(422).json({ success: false, message: 'El RUC debe tener 11 dígitos.' });

    await req.db.query(
      `UPDATE propietarios SET tipo_documento=?, nombre=?, apellido=?, dni=?,
       telefono=?, email=?, direccion=?, ruc=?, razon_social=?, direccion_fiscal=?
       WHERE id=?`,
      [tipo_documento, nombre.trim(), apellido.trim(), dni?.trim()||null,
       telefono?.trim()||null, email?.trim()||null, direccion?.trim()||null,
       ruc?.trim()||null, razon_social?.trim()||null, direccion_fiscal?.trim()||null,
       req.params.id]
    );
    return res.json({ success: true, message: 'Propietario actualizado.' });
  } catch (err) { next(err); }
});

module.exports = router;