'use strict';

/**
 * VetNetcodip SaaS — Rutas de Sedes
 * Base: /api/v1/sedes
 * Solo el rol 'admin' puede crear/editar/eliminar sedes.
 * Todos los roles autenticados pueden listar (para selects en formularios).
 */

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = Router();
router.use(authenticate);

// ── GET /api/v1/sedes — listar todas las sedes (todos los roles) ──
router.get('/', async (req, res, next) => {
  try {
    const { activo } = req.query;
    let sql = 'SELECT id, nombre, direccion, telefono, email, ciudad, activo, es_principal FROM sedes WHERE 1=1';
    const params = [];
    if (activo !== undefined) {
      sql += ' AND activo = ?';
      params.push(activo === 'false' ? 0 : 1);
    }
    sql += ' ORDER BY es_principal DESC, nombre ASC';
    const rows = await req.db.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/v1/sedes/:id ─────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const [sede] = await req.db.query(
      'SELECT * FROM sedes WHERE id = ?',
      [req.params.id]
    );
    if (!sede) return res.status(404).json({ success: false, message: 'Sede no encontrada.' });
    return res.json({ success: true, data: sede });
  } catch (err) { next(err); }
});

// ── POST /api/v1/sedes — crear sede (solo admin) ──────────────────
router.post('/', authorize('admin'), async (req, res, next) => {
  try {
    const { nombre, direccion, telefono, email, ciudad, es_principal = 0 } = req.body;

    if (!nombre?.trim()) {
      return res.status(422).json({ success: false, message: 'El nombre de la sede es obligatorio.' });
    }

    // Si se marca como principal, desmarcar las demás
    if (es_principal) {
      await req.db.query('UPDATE sedes SET es_principal = 0');
    }

    const result = await req.db.query(
      `INSERT INTO sedes (nombre, direccion, telefono, email, ciudad, es_principal, activo)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [nombre.trim(), direccion?.trim() || null, telefono?.trim() || null,
       email?.trim() || null, ciudad?.trim() || null, es_principal ? 1 : 0]
    );

    return res.status(201).json({
      success: true,
      message: 'Sede creada correctamente.',
      data: { id: result.insertId },
    });
  } catch (err) { next(err); }
});

// ── PUT /api/v1/sedes/:id — editar sede (solo admin) ─────────────
router.put('/:id', authorize('admin'), async (req, res, next) => {
  try {
    const { nombre, direccion, telefono, email, ciudad, es_principal } = req.body;

    if (!nombre?.trim()) {
      return res.status(422).json({ success: false, message: 'El nombre de la sede es obligatorio.' });
    }

    const [existe] = await req.db.query('SELECT id FROM sedes WHERE id = ?', [req.params.id]);
    if (!existe) return res.status(404).json({ success: false, message: 'Sede no encontrada.' });

    // Si se marca como principal, desmarcar las demás
    if (es_principal) {
      await req.db.query('UPDATE sedes SET es_principal = 0 WHERE id != ?', [req.params.id]);
    }

    await req.db.query(
      `UPDATE sedes SET nombre=?, direccion=?, telefono=?, email=?, ciudad=?, es_principal=?
       WHERE id=?`,
      [nombre.trim(), direccion?.trim() || null, telefono?.trim() || null,
       email?.trim() || null, ciudad?.trim() || null, es_principal ? 1 : 0, req.params.id]
    );

    return res.json({ success: true, message: 'Sede actualizada correctamente.' });
  } catch (err) { next(err); }
});

// ── PATCH /api/v1/sedes/:id/toggle — activar/desactivar ──────────
router.patch('/:id/toggle', authorize('admin'), async (req, res, next) => {
  try {
    const [sede] = await req.db.query('SELECT id, nombre, activo, es_principal FROM sedes WHERE id=?', [req.params.id]);
    if (!sede) return res.status(404).json({ success: false, message: 'Sede no encontrada.' });

    if (sede.es_principal && sede.activo) {
      return res.status(422).json({ success: false, message: 'No puedes desactivar la sede principal.' });
    }

    const nuevoEstado = sede.activo ? 0 : 1;
    await req.db.query('UPDATE sedes SET activo=? WHERE id=?', [nuevoEstado, req.params.id]);

    return res.json({
      success: true,
      message: nuevoEstado ? `${sede.nombre} activada.` : `${sede.nombre} desactivada.`,
      data: { activo: nuevoEstado },
    });
  } catch (err) { next(err); }
});

// ── DELETE /api/v1/sedes/:id — eliminar sede (solo admin) ─────────
router.delete('/:id', authorize('admin'), async (req, res, next) => {
  try {
    const [sede] = await req.db.query('SELECT id, nombre, es_principal FROM sedes WHERE id=?', [req.params.id]);
    if (!sede) return res.status(404).json({ success: false, message: 'Sede no encontrada.' });

    if (sede.es_principal) {
      return res.status(422).json({ success: false, message: 'No puedes eliminar la sede principal.' });
    }

    // Verificar si tiene usuarios asignados
    const [uso] = await req.db.query(
      'SELECT COUNT(*) AS total FROM usuarios WHERE sede_id = ?', [req.params.id]
    );
    if (uso.total > 0) {
      return res.status(422).json({
        success: false,
        message: `No puedes eliminar esta sede porque tiene ${uso.total} usuario(s) asignado(s). Reasígnalos primero.`,
      });
    }

    await req.db.query('DELETE FROM sedes WHERE id=?', [req.params.id]);
    return res.json({ success: true, message: 'Sede eliminada correctamente.' });
  } catch (err) { next(err); }
});

module.exports = router;