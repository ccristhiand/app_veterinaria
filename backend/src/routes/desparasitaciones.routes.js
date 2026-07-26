'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = Router();
router.use(authenticate);

// ── GET /api/v1/desparasitaciones?mascota_id=X ───────────────
router.get('/', async (req, res, next) => {
  try {
    const { mascota_id } = req.query;
    if (!mascota_id) return res.status(422).json({ success: false, message: 'mascota_id requerido' });

    const rows = await req.db.query(
      `SELECT d.*, u.nombre AS veterinario_nombre
       FROM desparasitaciones d
       JOIN usuarios u ON u.id = d.veterinario_id
       WHERE d.mascota_id = ?
       ORDER BY d.fecha_aplicacion DESC`,
      [mascota_id]
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── POST /api/v1/desparasitaciones ───────────────────────────
router.post('/', authorize('admin', 'veterinario'), async (req, res, next) => {
  try {
    const { mascota_id, tipo, producto, dosis, fecha_aplicacion, proxima_dosis, notas } = req.body;
    if (!mascota_id || !producto || !fecha_aplicacion) {
      return res.status(422).json({ success: false, message: 'mascota_id, producto y fecha_aplicacion son requeridos' });
    }
    const r = await req.db.query(
      `INSERT INTO desparasitaciones
         (mascota_id, veterinario_id, tipo, producto, dosis, fecha_aplicacion, proxima_dosis, notas)
       VALUES (?,?,?,?,?,?,?,?)`,
      [mascota_id, req.user.id, tipo || 'interna', producto, dosis || null,
       fecha_aplicacion, proxima_dosis || null, notas || null]
    );
    return res.status(201).json({ success: true, data: { id: r.insertId }, message: 'Desparasitación registrada.' });
  } catch (err) { next(err); }
});

// ── PUT /api/v1/desparasitaciones/:id ────────────────────────
router.put('/:id', authorize('admin', 'veterinario'), async (req, res, next) => {
  try {
    const { tipo, producto, dosis, fecha_aplicacion, proxima_dosis, notas } = req.body;
    await req.db.query(
      `UPDATE desparasitaciones SET tipo=?, producto=?, dosis=?, fecha_aplicacion=?, proxima_dosis=?, notas=?, notificado=0
       WHERE id=?`,
      [tipo || 'interna', producto, dosis || null, fecha_aplicacion, proxima_dosis || null, notas || null, req.params.id]
    );
    return res.json({ success: true, message: 'Desparasitación actualizada.' });
  } catch (err) { next(err); }
});

// ── DELETE /api/v1/desparasitaciones/:id ─────────────────────
router.delete('/:id', authorize('admin'), async (req, res, next) => {
  try {
    await req.db.query('DELETE FROM desparasitaciones WHERE id=?', [req.params.id]);
    return res.json({ success: true, message: 'Desparasitación eliminada.' });
  } catch (err) { next(err); }
});

module.exports = router;