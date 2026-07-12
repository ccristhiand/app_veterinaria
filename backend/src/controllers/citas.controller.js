'use strict';

const { validationResult }       = require('express-validator');
const { query, withTransaction } = require('../config/database');
const { emitirNuevaCita }        = require('../sockets');
const logger                     = require('../config/logger');

// ── Listar citas ──────────────────────────────────────────────────
async function listar(req, res, next) {
  try {
    const { fecha, veterinario_id, estado, page = 1, limit = 20 } = req.query;
    const limitNum  = Math.min(parseInt(limit) || 20, 100);
    const offsetNum = (Math.max(parseInt(page) || 1, 1) - 1) * limitNum;

    let sql = `
      SELECT
        c.id, c.fecha_hora, c.duracion_min, c.motivo, c.estado, c.notas,
        m.id   AS mascota_id,     m.nombre AS mascota_nombre,   m.especie,
        p.id   AS propietario_id, CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
        u.id   AS veterinario_id, u.nombre AS veterinario_nombre,
        c.created_at
      FROM citas c
      JOIN mascotas     m ON m.id = c.mascota_id
      JOIN propietarios p ON p.id = m.propietario_id
      JOIN usuarios     u ON u.id = c.veterinario_id
      WHERE 1=1`;
    const params = [];

    if (fecha)           { sql += ' AND DATE(c.fecha_hora) = ?'; params.push(fecha); }
    if (veterinario_id)  { sql += ' AND c.veterinario_id = ?';   params.push(veterinario_id); }
    if (estado)          { sql += ' AND c.estado = ?';            params.push(estado); }
    if (req.user.rol === 'veterinario') {
      sql += ' AND c.veterinario_id = ?'; params.push(req.user.id);
    }

    sql += ` ORDER BY c.fecha_hora ASC LIMIT ${limitNum} OFFSET ${offsetNum}`;

    const rows = await query(sql, params);
    return res.json({ success: true, data: rows, page: parseInt(page) });
  } catch (err) { next(err); }
}

// ── Obtener cita por ID ───────────────────────────────────────────
async function obtener(req, res, next) {
  try {
    const [cita] = await query(
      `SELECT c.*, m.nombre AS mascota_nombre, m.especie,
              CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre, p.telefono,
              u.nombre AS veterinario_nombre
       FROM citas c
       JOIN mascotas m ON m.id = c.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       JOIN usuarios u ON u.id = c.veterinario_id
       WHERE c.id = ?`,
      [req.params.id],
    );
    if (!cita) return res.status(404).json({ success: false, message: 'Cita no encontrada.' });
    return res.json({ success: true, data: cita });
  } catch (err) { next(err); }
}

// ── Crear cita ────────────────────────────────────────────────────
async function crear(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { mascota_id, veterinario_id, fecha_hora, duracion_min = 30, motivo, notas } = req.body;

    const result = await withTransaction(async (conn) => {
      const [[mascota]] = await conn.execute(
        `SELECT m.id, m.nombre, p.nombre AS p_nombre, p.apellido AS p_apellido
         FROM mascotas m JOIN propietarios p ON p.id = m.propietario_id WHERE m.id = ?`,
        [mascota_id],
      );
      if (!mascota) throw Object.assign(new Error('Mascota no encontrada.'), { status: 404 });

      const [[vet]] = await conn.execute(
        "SELECT id, nombre FROM usuarios WHERE id = ? AND rol = 'veterinario' AND activo = 1",
        [veterinario_id],
      );
      if (!vet) throw Object.assign(new Error('Veterinario no válido.'), { status: 404 });

      const [ins] = await conn.execute(
        `INSERT INTO citas (mascota_id, veterinario_id, creada_por_id, fecha_hora, duracion_min, motivo, notas)
         VALUES (?,?,?,?,?,?,?)`,
        [mascota_id, veterinario_id, req.user.id, fecha_hora, duracion_min, motivo, notas || null],
      );

      return {
        id: ins.insertId, mascota_id,
        mascota_nombre    : mascota.nombre,
        propietario_nombre: `${mascota.p_nombre} ${mascota.p_apellido}`,
        veterinario_id, veterinario_nombre: vet.nombre,
        fecha_hora, duracion_min, motivo, estado: 'pendiente',
        notas, creada_por_id: req.user.id,
      };
    });

    const io = req.app.get('io');
    await emitirNuevaCita(io, result);

    logger.info(`📅 Cita #${result.id} creada por user #${req.user.id}`);
    return res.status(201).json({ success: true, data: result });
  } catch (err) { next(err); }
}

// ── Editar cita ───────────────────────────────────────────────────
// Roles: admin, recepcionista
// Campos editables: veterinario_id, fecha_hora, duracion_min, motivo, notas
// NO se puede cambiar: mascota_id, estado (usar PATCH /estado)
async function editar(req, res, next) {
  try {
    const { id } = req.params;
    const { veterinario_id, fecha_hora, duracion_min, motivo, notas } = req.body;

    if (!fecha_hora || !motivo || !veterinario_id) {
      return res.status(422).json({
        success: false,
        message: 'veterinario_id, fecha_hora y motivo son obligatorios.',
      });
    }

    // Verificar que la cita existe
    const [cita] = await query('SELECT id, estado FROM citas WHERE id = ?', [id]);
    if (!cita) return res.status(404).json({ success: false, message: 'Cita no encontrada.' });

    // No permitir editar citas ya completadas o canceladas
    if (['completada', 'cancelada'].includes(cita.estado)) {
      return res.status(422).json({
        success: false,
        message: `No se puede editar una cita ${cita.estado}.`,
      });
    }

    // Verificar que el veterinario existe
    const [vet] = await query(
      "SELECT id, nombre FROM usuarios WHERE id = ? AND rol = 'veterinario' AND activo = 1",
      [veterinario_id],
    );
    if (!vet) return res.status(404).json({ success: false, message: 'Veterinario no válido.' });

    await query(
      `UPDATE citas
       SET veterinario_id = ?, fecha_hora = ?, duracion_min = ?, motivo = ?, notas = ?
       WHERE id = ?`,
      [veterinario_id, fecha_hora, duracion_min || 30, motivo, notas || null, id],
    );

    // Notificar actualización en tiempo real
    const citaActualizada = await query(
      `SELECT c.*, m.nombre AS mascota_nombre, m.especie,
              CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
              u.nombre AS veterinario_nombre
       FROM citas c
       JOIN mascotas m ON m.id = c.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       JOIN usuarios u ON u.id = c.veterinario_id
       WHERE c.id = ?`,
      [id],
    );

    req.app.get('io').emit('cita:actualizada', {
      id     : parseInt(id),
      estado : cita.estado,
      payload: citaActualizada[0],
      ts     : new Date().toISOString(),
    });

    logger.info(`✏️ Cita #${id} editada por user #${req.user.id}`);
    return res.json({ success: true, message: 'Cita actualizada correctamente.', data: citaActualizada[0] });

  } catch (err) { next(err); }
}

// ── Actualizar estado ─────────────────────────────────────────────
async function actualizarEstado(req, res, next) {
  try {
    const { id } = req.params;
    const { estado } = req.body;

    const valid = ['pendiente', 'confirmada', 'en_curso', 'completada', 'cancelada'];
    if (!valid.includes(estado)) {
      return res.status(422).json({ success: false, message: 'Estado inválido.' });
    }

    const rows = await query('UPDATE citas SET estado = ? WHERE id = ?', [estado, id]);
    if (rows.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Cita no encontrada.' });
    }

    req.app.get('io').emit('cita:actualizada', {
      id    : parseInt(id),
      estado,
      ts    : new Date().toISOString(),
    });

    return res.json({ success: true, message: 'Estado actualizado.' });
  } catch (err) { next(err); }
}

module.exports = { listar, obtener, crear, editar, actualizarEstado };