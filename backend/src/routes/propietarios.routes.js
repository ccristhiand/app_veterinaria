'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/auth.middleware');

const router = Router();
router.use(authenticate);

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

router.post('/', async (req, res, next) => {
  try {
    const { nombre, apellido, dni, telefono, email, direccion, ruc, razon_social, direccion_fiscal } = req.body;
    if (!nombre?.trim() || !apellido?.trim()) {
      return res.status(422).json({ success: false, message: 'Nombre y apellido son obligatorios.' });
    }
    if (ruc && !/^\d{11}$/.test(ruc.trim())) {
      return res.status(422).json({ success: false, message: 'El RUC debe tener 11 dígitos.' });
    }
    const result = await req.db.query(
      `INSERT INTO propietarios (nombre, apellido, dni, telefono, email, direccion, ruc, razon_social, direccion_fiscal)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [nombre.trim(), apellido.trim(), dni?.trim()||null, telefono?.trim()||null,
       email?.trim()||null, direccion?.trim()||null, ruc?.trim()||null,
       razon_social?.trim()||null, direccion_fiscal?.trim()||null]
    );
    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { nombre, apellido, dni, telefono, email, direccion, ruc, razon_social, direccion_fiscal } = req.body;
    if (!nombre?.trim() || !apellido?.trim()) {
      return res.status(422).json({ success: false, message: 'Nombre y apellido son obligatorios.' });
    }
    if (ruc && !/^\d{11}$/.test(ruc.trim())) {
      return res.status(422).json({ success: false, message: 'El RUC debe tener 11 dígitos.' });
    }
    await req.db.query(
      `UPDATE propietarios SET nombre=?, apellido=?, dni=?, telefono=?, email=?, direccion=?,
       ruc=?, razon_social=?, direccion_fiscal=? WHERE id=?`,
      [nombre.trim(), apellido.trim(), dni?.trim()||null, telefono?.trim()||null,
       email?.trim()||null, direccion?.trim()||null, ruc?.trim()||null,
       razon_social?.trim()||null, direccion_fiscal?.trim()||null, req.params.id]
    );
    return res.json({ success: true, message: 'Propietario actualizado.' });
  } catch (err) { next(err); }
});

module.exports = router;