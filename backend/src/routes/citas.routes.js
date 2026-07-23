'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditLog, auditMiddleware, auditAuth } = require('../middlewares/audit.middleware');


const router = Router();
router.use(authenticate);

// GET /api/v1/citas
router.get('/', async (req, res, next) => {
  try {
    const { fecha, estado, veterinario_id, mascota_id } = req.query;
    let sql = `
      SELECT c.*, m.nombre AS mascota_nombre, m.especie,
             CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre, p.telefono,
             u.nombre AS veterinario_nombre
      FROM citas c
      JOIN mascotas m ON m.id = c.mascota_id
      JOIN propietarios p ON p.id = m.propietario_id
      JOIN usuarios u ON u.id = c.veterinario_id
      WHERE 1=1`;
    const params = [];
    if (fecha)          { sql += ' AND DATE(c.fecha_hora) = ?'; params.push(fecha); }
    if (estado)         { sql += ' AND c.estado = ?';           params.push(estado); }
    if (veterinario_id) { sql += ' AND c.veterinario_id = ?';   params.push(veterinario_id); }
    if (mascota_id)     { sql += ' AND c.mascota_id = ?';       params.push(mascota_id); }
    sql += ' ORDER BY c.fecha_hora ASC';
    const rows = await req.db.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/v1/citas/:id
router.get('/:id', async (req, res, next) => {
  try {
    const [cita] = await req.db.query(
      `SELECT c.*, m.nombre AS mascota_nombre, m.especie, m.raza,
              CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre, p.telefono,
              u.nombre AS veterinario_nombre
       FROM citas c
       JOIN mascotas m ON m.id = c.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       JOIN usuarios u ON u.id = c.veterinario_id
       WHERE c.id = ?`, [req.params.id]
    );
    if (!cita) return res.status(404).json({ success: false, message: 'Cita no encontrada.' });
    return res.json({ success: true, data: cita });
  } catch (err) { next(err); }
});

// POST /api/v1/citas
router.post('/', auditMiddleware('citas:creado', 'citas'), async (req, res, next) => {
  try {
    const { mascota_id, veterinario_id, fecha_hora, duracion_min, motivo, notas } = req.body;
    if (!mascota_id || !veterinario_id || !fecha_hora || !motivo)
      return res.status(422).json({ success: false, message: 'Campos obligatorios faltantes.' });

    const result = await req.db.query(
      `INSERT INTO citas (mascota_id, veterinario_id, creada_por_id, fecha_hora, duracion_min, motivo, notas)
       VALUES (?,?,?,?,?,?,?)`,
      [mascota_id, veterinario_id, req.user.id, fecha_hora, duracion_min||30, motivo, notas||null]
    );

    // Emitir evento WebSocket
    const io = req.app.get('io');
    if (io) {
      const [cita] = await req.db.query(
        `SELECT c.*, m.nombre AS mascota_nombre, CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre
         FROM citas c JOIN mascotas m ON m.id=c.mascota_id JOIN propietarios p ON p.id=m.propietario_id
         WHERE c.id=?`, [result.insertId]
      );
      io.emit('cita:nueva', { type:'cita:nueva', payload: cita });
    }

    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) { next(err); }
});

// PUT /api/v1/citas/:id
router.put('/:id', auditMiddleware('citas:actualizado', 'citas'), async (req, res, next) => {
  try {
    const { fecha_hora, duracion_min, motivo, notas, estado, veterinario_id } = req.body;
    await req.db.query(
      `UPDATE citas SET fecha_hora=?, duracion_min=?, motivo=?, notas=?, estado=?, veterinario_id=?
       WHERE id=?`,
      [fecha_hora, duracion_min||30, motivo, notas||null, estado||'pendiente', veterinario_id, req.params.id]
    );
    const io = req.app.get('io');
    if (io) io.emit('cita:actualizada', { type:'cita:actualizada', payload: { id: req.params.id } });
    return res.json({ success: true, message: 'Cita actualizada.' });
  } catch (err) { next(err); }
});

// PATCH /api/v1/citas/:id/estado
router.patch('/:id/estado', auditMiddleware('citas:actualizado', 'citas'), async (req, res, next) => {
  try {
    const { estado } = req.body;
    await req.db.query('UPDATE citas SET estado=? WHERE id=?', [estado, req.params.id]);
    const io = req.app.get('io');
    if (io) io.emit('cita:actualizada', { type:'cita:actualizada', payload: { id: req.params.id, estado } });
    return res.json({ success: true, message: 'Estado actualizado.' });
  } catch (err) { next(err); }
});

module.exports = router;