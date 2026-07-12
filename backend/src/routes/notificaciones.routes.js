'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/auth.middleware');

const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const rows = await req.db.query(
      `SELECT * FROM notificaciones
       WHERE (usuario_id = ? OR usuario_id IS NULL) AND leida = 0
       ORDER BY created_at DESC LIMIT 30`,
      [req.user.id]
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

router.patch('/leer-todas', async (req, res, next) => {
  try {
    await req.db.query(
      'UPDATE notificaciones SET leida = 1 WHERE usuario_id = ? OR usuario_id IS NULL',
      [req.user.id]
    );
    return res.json({ success: true, message: 'Notificaciones marcadas como leídas.' });
  } catch (err) { next(err); }
});

router.patch('/:id/leer', async (req, res, next) => {
  try {
    await req.db.query('UPDATE notificaciones SET leida = 1 WHERE id = ?', [req.params.id]);
    return res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;