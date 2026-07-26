'use strict';

/**
 * VetClinic SaaS — WA Campañas Routes
 * Las campañas se guardan en la BD del tenant (req.db), no en master
 */

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = Router();
router.use(authenticate);

// ── GET /api/v1/wa/campanas ───────────────────────────────────
router.get('/', authorize('admin'), async (req, res, next) => {
  try {
    const rows = await req.db.query(
      `SELECT id, nombre, segmento, segmento_valor, estado,
              total, enviados, fallidos, programada_at, iniciada_at, completada_at, created_at
       FROM wa_campanas ORDER BY created_at DESC LIMIT 50`
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── POST /api/v1/wa/campanas ──────────────────────────────────
router.post('/', authorize('admin'), async (req, res, next) => {
  try {
    const { nombre, mensaje, segmento, segmento_valor, programada_at } = req.body;
    if (!nombre || !mensaje) {
      return res.status(422).json({ success: false, message: 'nombre y mensaje requeridos' });
    }
    const r = await req.db.query(
      `INSERT INTO wa_campanas (nombre, mensaje, segmento, segmento_valor, estado, programada_at)
       VALUES (?,?,?,?,?,?)`,
      [nombre, mensaje,
       segmento || 'todos',
       segmento_valor || null,
       programada_at ? 'programada' : 'borrador',
       programada_at || null]
    );
    return res.status(201).json({ success: true, data: { id: r.insertId } });
  } catch (err) { next(err); }
});

// ── POST /api/v1/wa/campanas/:id/iniciar ─────────────────────
router.post('/:id/iniciar', authorize('admin'), async (req, res, next) => {
  try {
    const [c] = await req.db.query(
      'SELECT * FROM wa_campanas WHERE id=?', [req.params.id]
    );
    if (!c) return res.status(404).json({ success: false, message: 'Campaña no encontrada' });
    if (!['borrador','pausada'].includes(c.estado)) {
      return res.status(422).json({ success: false, message: `No se puede iniciar desde estado: ${c.estado}` });
    }
    await req.db.query(
      "UPDATE wa_campanas SET estado='enviando', iniciada_at=IFNULL(iniciada_at,NOW()) WHERE id=?",
      [req.params.id]
    );
    return res.json({ success: true, message: 'Campaña iniciada.' });
  } catch (err) { next(err); }
});

// ── POST /api/v1/wa/campanas/:id/pausar ──────────────────────
router.post('/:id/pausar', authorize('admin'), async (req, res, next) => {
  try {
    await req.db.query(
      "UPDATE wa_campanas SET estado='pausada', pausada_at=NOW() WHERE id=? AND estado='enviando'",
      [req.params.id]
    );
    return res.json({ success: true, message: 'Campaña pausada.' });
  } catch (err) { next(err); }
});

// ── POST /api/v1/wa/campanas/:id/cancelar ────────────────────
router.post('/:id/cancelar', authorize('admin'), async (req, res, next) => {
  try {
    await req.db.query(
      "UPDATE wa_campanas SET estado='cancelada' WHERE id=? AND estado IN ('borrador','programada','enviando','pausada')",
      [req.params.id]
    );
    return res.json({ success: true, message: 'Campaña cancelada.' });
  } catch (err) { next(err); }
});

// ── GET /api/v1/wa/campanas/:id/progreso ─────────────────────
router.get('/:id/progreso', authorize('admin'), async (req, res, next) => {
  try {
    const [c] = await req.db.query(
      'SELECT id, nombre, estado, total, enviados, fallidos FROM wa_campanas WHERE id=?',
      [req.params.id]
    );
    if (!c) return res.status(404).json({ success: false, message: 'No encontrada' });
    const pct = c.total > 0 ? Math.round((c.enviados / c.total) * 100) : 0;
    return res.json({ success: true, data: { ...c, porcentaje: pct } });
  } catch (err) { next(err); }
});

module.exports = router;