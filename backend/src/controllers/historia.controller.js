'use strict';

const { validationResult }       = require('express-validator');
const { query, withTransaction } = require('../config/database');

// ── Listar por mascota ────────────────────────────────────────────
async function listarPorMascota(req, res, next) {
  try {
    const { mascota_id } = req.params;
    const rows = await query(
      `SELECT h.*, u.nombre AS veterinario_nombre
       FROM historia_clinica h
       JOIN usuarios u ON u.id = h.veterinario_id
       WHERE h.mascota_id = ?
       ORDER BY h.fecha DESC`,
      [mascota_id],
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
}

// ── Obtener consulta por ID ───────────────────────────────────────
async function obtener(req, res, next) {
  try {
    const [consulta] = await query(
      `SELECT h.*, u.nombre AS veterinario_nombre,
              m.nombre AS mascota_nombre, m.especie
       FROM historia_clinica h
       JOIN usuarios u ON u.id = h.veterinario_id
       JOIN mascotas m ON m.id = h.mascota_id
       WHERE h.id = ?`,
      [req.params.id],
    );
    if (!consulta) return res.status(404).json({ success: false, message: 'Consulta no encontrada.' });

    const recetas = await query(
      'SELECT * FROM recetas WHERE historia_clinica_id = ?',
      [req.params.id],
    );

    return res.json({ success: true, data: { ...consulta, recetas } });
  } catch (err) { next(err); }
}

// ── Crear consulta ────────────────────────────────────────────────
async function crear(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const {
      mascota_id, cita_id, motivo, anamnesis, exploracion,
      diagnostico, tratamiento, observaciones, peso_kg, temperatura_c,
      recetas = [],
    } = req.body;

    const resultado = await withTransaction(async (conn) => {
      const [[mascota]] = await conn.execute('SELECT id FROM mascotas WHERE id = ?', [mascota_id]);
      if (!mascota) throw Object.assign(new Error('Mascota no encontrada.'), { status: 404 });

      const [ins] = await conn.execute(
        `INSERT INTO historia_clinica
           (mascota_id, veterinario_id, cita_id, motivo, anamnesis, exploracion,
            diagnostico, tratamiento, observaciones, peso_kg, temperatura_c)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          mascota_id, req.user.id, cita_id || null, motivo,
          anamnesis || null, exploracion || null, diagnostico || null,
          tratamiento || null, observaciones || null,
          peso_kg || null, temperatura_c || null,
        ],
      );

      const historiaId = ins.insertId;

      if (recetas.length > 0) {
        const placeholders = recetas.map(() => '(?,?,?,?,?,?)').join(',');
        const values = recetas.flatMap((r) => [
          historiaId, r.medicamento, r.dosis, r.frecuencia,
          r.duracion_dias || null, r.instrucciones || null,
        ]);
        await conn.execute(
          `INSERT INTO recetas (historia_clinica_id, medicamento, dosis, frecuencia, duracion_dias, instrucciones)
           VALUES ${placeholders}`,
          values,
        );
      }

      if (cita_id) {
        await conn.execute("UPDATE citas SET estado='completada' WHERE id=?", [cita_id]);
      }

      return { id: historiaId, recetasInsertadas: recetas.length };
    });

    return res.status(201).json({ success: true, data: resultado });
  } catch (err) { next(err); }
}

// ── Editar consulta ───────────────────────────────────────────────
// Admin: puede editar cualquier consulta
// Veterinario: solo las suyas (veterinario_id === req.user.id)
async function editar(req, res, next) {
  try {
    const { id } = req.params;
    const {
      motivo, anamnesis, exploracion, diagnostico,
      tratamiento, observaciones, peso_kg, temperatura_c,
      recetas = [],
    } = req.body;

    if (!motivo || !motivo.trim()) {
      return res.status(422).json({ success: false, message: 'El motivo es obligatorio.' });
    }

    // Verificar que la consulta existe
    const [consulta] = await query(
      'SELECT id, veterinario_id FROM historia_clinica WHERE id = ?',
      [id],
    );
    if (!consulta) {
      return res.status(404).json({ success: false, message: 'Consulta no encontrada.' });
    }

    // Control de rol: veterinario solo edita las suyas
    if (req.user.rol === 'veterinario' && consulta.veterinario_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Solo puedes editar tus propias consultas.',
      });
    }

    await withTransaction(async (conn) => {
      // Actualizar consulta
      await conn.execute(
        `UPDATE historia_clinica SET
           motivo = ?, anamnesis = ?, exploracion = ?, diagnostico = ?,
           tratamiento = ?, observaciones = ?, peso_kg = ?, temperatura_c = ?
         WHERE id = ?`,
        [
          motivo, anamnesis || null, exploracion || null, diagnostico || null,
          tratamiento || null, observaciones || null,
          peso_kg || null, temperatura_c || null,
          id,
        ],
      );

      // Re-insertar recetas: eliminar las anteriores y guardar las nuevas
      await conn.execute('DELETE FROM recetas WHERE historia_clinica_id = ?', [id]);

      if (recetas.length > 0) {
        const placeholders = recetas.map(() => '(?,?,?,?,?,?)').join(',');
        const values = recetas.flatMap((r) => [
          id, r.medicamento, r.dosis, r.frecuencia,
          r.duracion_dias || null, r.instrucciones || null,
        ]);
        await conn.execute(
          `INSERT INTO recetas (historia_clinica_id, medicamento, dosis, frecuencia, duracion_dias, instrucciones)
           VALUES ${placeholders}`,
          values,
        );
      }
    });

    return res.json({ success: true, message: 'Consulta actualizada correctamente.' });

  } catch (err) { next(err); }
}

module.exports = { listarPorMascota, obtener, crear, editar };