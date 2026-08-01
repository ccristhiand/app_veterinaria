'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');

const router = Router();
router.use(authenticate);

// GET /api/v1/historia?mascota_id=X
router.get('/', async (req, res, next) => {
  try {
    const { mascota_id } = req.query;
    if (!mascota_id) return res.status(422).json({ success: false, message: 'mascota_id requerido.' });
    const rows = await req.db.query(
      `SELECT h.*, u.nombre AS veterinario_nombre
       FROM historia_clinica h
       JOIN usuarios u ON u.id = h.veterinario_id
       WHERE h.mascota_id = ?
       ORDER BY h.fecha DESC`, [mascota_id]
    );
    for (const h of rows) {
      h.recetas      = await req.db.query('SELECT * FROM recetas WHERE historia_clinica_id = ?', [h.id]);
      h.seguimientos = await req.db.query(
        `SELECT s.*, u.nombre AS veterinario_nombre
         FROM historia_seguimientos s
         JOIN usuarios u ON u.id = s.veterinario_id
         WHERE s.historia_id = ?
         ORDER BY s.fecha ASC`, [h.id]
      );
    }
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/v1/historia/:id
router.get('/:id', async (req, res, next) => {
  try {
    const [h] = await req.db.query(
      `SELECT h.*, u.nombre AS veterinario_nombre,
              m.nombre AS mascota_nombre, m.especie
       FROM historia_clinica h
       JOIN usuarios u ON u.id = h.veterinario_id
       JOIN mascotas m ON m.id = h.mascota_id
       WHERE h.id = ?`, [req.params.id]
    );
    if (!h) return res.status(404).json({ success: false, message: 'Consulta no encontrada.' });
    h.recetas      = await req.db.query('SELECT * FROM recetas WHERE historia_clinica_id = ?', [h.id]);
    h.seguimientos = await req.db.query(
      `SELECT s.*, u.nombre AS veterinario_nombre
       FROM historia_seguimientos s
       JOIN usuarios u ON u.id = s.veterinario_id
       WHERE s.historia_id = ?
       ORDER BY s.fecha ASC`, [h.id]
    );
    return res.json({ success: true, data: h });
  } catch (err) { next(err); }
});

// POST /api/v1/historia
router.post('/', auditMiddleware('historia_clinica:creado', 'historia_clinica'), async (req, res, next) => {
  try {
    const { mascota_id, cita_id, fecha, motivo, anamnesis, exploracion,
            diagnostico, tratamiento, observaciones, peso_kg, temperatura_c, recetas } = req.body;
    if (!mascota_id || !motivo)
      return res.status(422).json({ success: false, message: 'mascota_id y motivo requeridos.' });

    const result = await req.db.withTransaction(async (conn) => {
      const [ins] = await conn.execute(
        `INSERT INTO historia_clinica
           (mascota_id, veterinario_id, cita_id, fecha, motivo, anamnesis,
            exploracion, diagnostico, tratamiento, observaciones, peso_kg, temperatura_c)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [mascota_id, req.user.id, cita_id||null, fecha||new Date(), motivo,
         anamnesis||null, exploracion||null, diagnostico||null, tratamiento||null,
         observaciones||null, peso_kg||null, temperatura_c||null]
      );
      const hId = ins.insertId;
      if (recetas?.length) {
        for (const r of recetas) {
          await conn.execute(
            'INSERT INTO recetas (historia_clinica_id, medicamento, dosis, frecuencia, duracion_dias, instrucciones) VALUES (?,?,?,?,?,?)',
            [hId, r.medicamento, r.dosis, r.frecuencia, r.duracion_dias||null, r.instrucciones||null]
          );
        }
      }
      if (cita_id) {
        await conn.execute("UPDATE citas SET estado='completada' WHERE id=?", [cita_id]);
      }
      return { id: hId };
    });
    return res.status(201).json({ success: true, data: result });
  } catch (err) { next(err); }
});

// PUT /api/v1/historia/:id
router.put('/:id', auditMiddleware('historia_clinica:actualizado', 'historia_clinica'), async (req, res, next) => {
  try {
    const { motivo, anamnesis, exploracion, diagnostico, tratamiento,
            observaciones, peso_kg, temperatura_c, recetas } = req.body;
    await req.db.withTransaction(async (conn) => {
      await conn.execute(
        `UPDATE historia_clinica SET motivo=?, anamnesis=?, exploracion=?,
         diagnostico=?, tratamiento=?, observaciones=?, peso_kg=?, temperatura_c=?
         WHERE id=?`,
        [motivo, anamnesis||null, exploracion||null, diagnostico||null,
         tratamiento||null, observaciones||null, peso_kg||null, temperatura_c||null, req.params.id]
      );
      if (recetas) {
        await conn.execute('DELETE FROM recetas WHERE historia_clinica_id = ?', [req.params.id]);
        for (const r of recetas) {
          await conn.execute(
            'INSERT INTO recetas (historia_clinica_id, medicamento, dosis, frecuencia, duracion_dias, instrucciones) VALUES (?,?,?,?,?,?)',
            [req.params.id, r.medicamento, r.dosis, r.frecuencia, r.duracion_dias||null, r.instrucciones||null]
          );
        }
      }
    });
    return res.json({ success: true, message: 'Consulta actualizada.' });
  } catch (err) { next(err); }
});

// ── SEGUIMIENTOS ──────────────────────────────────────────────────

// GET /api/v1/historia/:id/seguimientos
router.get('/:id/seguimientos', async (req, res, next) => {
  try {
    const rows = await req.db.query(
      `SELECT s.*, u.nombre AS veterinario_nombre
       FROM historia_seguimientos s
       JOIN usuarios u ON u.id = s.veterinario_id
       WHERE s.historia_id = ?
       ORDER BY s.fecha ASC`, [req.params.id]
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/v1/historia/:id/seguimientos
router.post('/:id/seguimientos', auditMiddleware('historia_clinica:actualizado', 'historia_clinica'), async (req, res, next) => {
  try {
    const { evolucion, tratamiento, observaciones, peso_kg, temperatura_c, fecha } = req.body;

    if (!evolucion?.trim())
      return res.status(422).json({ success: false, message: 'La evolución es obligatoria.' });

    // Verificar que la consulta existe
    const [historia] = await req.db.query('SELECT id FROM historia_clinica WHERE id = ?', [req.params.id]);
    if (!historia) return res.status(404).json({ success: false, message: 'Consulta no encontrada.' });

    const result = await req.db.query(
      `INSERT INTO historia_seguimientos
         (historia_id, veterinario_id, fecha, evolucion, tratamiento, observaciones, peso_kg, temperatura_c)
       VALUES (?,?,?,?,?,?,?,?)`,
      [req.params.id, req.user.id, fecha || new Date(),
       evolucion.trim(), tratamiento?.trim()||null, observaciones?.trim()||null,
       peso_kg||null, temperatura_c||null]
    );

    return res.status(201).json({
      success: true,
      message: 'Seguimiento agregado correctamente.',
      data: { id: result.insertId },
    });
  } catch (err) { next(err); }
});

// DELETE /api/v1/historia/:id/seguimientos/:segId
router.delete('/:id/seguimientos/:segId', authorize('admin', 'veterinario'), async (req, res, next) => {
  try {
    await req.db.query(
      'DELETE FROM historia_seguimientos WHERE id = ? AND historia_id = ?',
      [req.params.segId, req.params.id]
    );
    return res.json({ success: true, message: 'Seguimiento eliminado.' });
  } catch (err) { next(err); }
});


// DELETE /api/v1/historia/:id
router.delete('/:id', authorize('admin', 'veterinario'), auditMiddleware('historia_clinica:eliminado', 'historia_clinica'), async (req, res, next) => {
  try {
    const [h] = await req.db.query('SELECT id FROM historia_clinica WHERE id = ?', [req.params.id]);
    if (!h) return res.status(404).json({ success: false, message: 'Consulta no encontrada.' });

    await req.db.withTransaction(async (conn) => {
      await conn.execute('DELETE FROM historia_seguimientos WHERE historia_id = ?', [req.params.id]);
      await conn.execute('DELETE FROM recetas WHERE historia_clinica_id = ?', [req.params.id]);
      await conn.execute('DELETE FROM historia_clinica WHERE id = ?', [req.params.id]);
    });

    return res.json({ success: true, message: 'Consulta eliminada correctamente.' });
  } catch (err) { next(err); }
});

module.exports = router;