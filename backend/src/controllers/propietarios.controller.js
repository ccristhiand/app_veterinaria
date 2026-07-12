'use strict';

const { validationResult } = require('express-validator');
const { query }            = require('../config/database');

async function listar(req, res, next) {
  try {
    const { search = '', page = 1, limit = 20 } = req.query;
    const limitNum  = Math.min(parseInt(limit) || 20, 100);
    const offsetNum = (Math.max(parseInt(page) || 1, 1) - 1) * limitNum;
    const like = `%${search}%`;

    const rows = await query(
      `SELECT p.*,
              COUNT(m.id) AS total_mascotas
       FROM propietarios p
       LEFT JOIN mascotas m ON m.propietario_id = p.id AND m.activa = 1
       WHERE p.apellido LIKE ? OR p.nombre LIKE ? OR p.dni LIKE ? OR p.telefono LIKE ?
       GROUP BY p.id
       ORDER BY p.apellido, p.nombre
       LIMIT ${limitNum} OFFSET ${offsetNum}`,
      [like, like, like, like],
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
}
async function obtener(req, res, next) {
  try {
    const [prop] = await query('SELECT * FROM propietarios WHERE id = ?', [req.params.id]);
    if (!prop) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    const mascotas = await query(
      'SELECT * FROM mascotas WHERE propietario_id = ? ORDER BY nombre',
      [req.params.id],
    );

    return res.json({ success: true, data: { ...prop, mascotas } });
  } catch (err) { next(err); }
}

async function crear(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { nombre, apellido, dni, telefono, email, direccion, notas } = req.body;

    const result = await query(
      'INSERT INTO propietarios (nombre, apellido, dni, telefono, email, direccion, notas) VALUES (?,?,?,?,?,?,?)',
      [nombre, apellido, dni || null, telefono, email || null, direccion || null, notas || null],
    );

    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'El DNI ya está registrado.' });
    }
    next(err);
  }
}

async function actualizar(req, res, next) {
  try {
    const { nombre, apellido, dni, telefono, email, direccion, notas } = req.body;

    const result = await query(
      `UPDATE propietarios SET nombre=?, apellido=?, dni=?, telefono=?, email=?, direccion=?, notas=?
       WHERE id = ?`,
      [nombre, apellido, dni || null, telefono, email || null, direccion || null, notas || null, req.params.id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });
    }
    return res.json({ success: true, message: 'Actualizado correctamente.' });
  } catch (err) { next(err); }
}

module.exports = { listar, obtener, crear, actualizar };
