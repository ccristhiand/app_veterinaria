'use strict';

const { validationResult } = require('express-validator');
const { query }            = require('../config/database');

async function listar(req, res, next) {
  try {
    const { propietario_id, search = '' } = req.query;
    const like = `%${search}%`;
    let sql = `
      SELECT m.*, CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre
      FROM mascotas m
      JOIN propietarios p ON p.id = m.propietario_id
      WHERE (m.nombre LIKE ? OR m.raza LIKE ? OR m.microchip LIKE ?)
    `;
    const params = [like, like, like];

    if (propietario_id) {
      sql += ' AND m.propietario_id = ?';
      params.push(propietario_id);
    }

    sql += ' ORDER BY m.nombre LIMIT 50';
    const rows = await query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
}

async function obtener(req, res, next) {
  try {
    const [mascota] = await query(
      `SELECT m.*, CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre, p.telefono, p.email AS propietario_email
       FROM mascotas m JOIN propietarios p ON p.id = m.propietario_id
       WHERE m.id = ?`,
      [req.params.id],
    );
    if (!mascota) return res.status(404).json({ success: false, message: 'Mascota no encontrada.' });

    // Historial vacunas
    const vacunas = await query(
      'SELECT * FROM vacunas WHERE mascota_id = ? ORDER BY fecha_aplicacion DESC',
      [req.params.id],
    );

    return res.json({ success: true, data: { ...mascota, vacunas } });
  } catch (err) { next(err); }
}

async function crear(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const {
      propietario_id, nombre, especie, raza, fecha_nacimiento,
      sexo, peso_kg, color, microchip, alergias, alertas_medicas, foto_url,
    } = req.body;

    // Verificar propietario
    const [prop] = await query('SELECT id FROM propietarios WHERE id = ?', [propietario_id]);
    if (!prop) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    const result = await query(
      `INSERT INTO mascotas
         (propietario_id, nombre, especie, raza, fecha_nacimiento, sexo, peso_kg, color, microchip, alergias, alertas_medicas, foto_url)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [propietario_id, nombre, especie, raza || null, fecha_nacimiento || null,
       sexo || 'desconocido', peso_kg || null, color || null, microchip || null,
       alergias || null, alertas_medicas || null, foto_url || null],
    );

    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Microchip ya registrado.' });
    }
    next(err);
  }
}

async function actualizar(req, res, next) {
  try {
    const { nombre, especie, raza, fecha_nacimiento, sexo, peso_kg, color, microchip, alergias, alertas_medicas, foto_url } = req.body;

    const result = await query(
      `UPDATE mascotas SET nombre=?,especie=?,raza=?,fecha_nacimiento=?,sexo=?,peso_kg=?,
              color=?,microchip=?,alergias=?,alertas_medicas=?,foto_url=?
       WHERE id = ?`,
      [nombre, especie, raza || null, fecha_nacimiento || null, sexo,
       peso_kg || null, color || null, microchip || null,
       alergias || null, alertas_medicas || null, foto_url || null, req.params.id],
    );

    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Mascota no encontrada.' });
    return res.json({ success: true, message: 'Actualizada correctamente.' });
  } catch (err) { next(err); }
}

module.exports = { listar, obtener, crear, actualizar };
