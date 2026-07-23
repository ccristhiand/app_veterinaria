'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/auth.middleware');
const { auditLog, auditMiddleware, auditAuth } = require('../middlewares/audit.middleware');


const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { mascota_id, proximas } = req.query;
    let sql = `SELECT v.*, u.nombre AS veterinario_nombre,
                      m.nombre AS mascota_nombre
               FROM vacunas v
               JOIN usuarios u ON u.id = v.veterinario_id
               JOIN mascotas m ON m.id = v.mascota_id
               WHERE 1=1`;
    const params = [];
    if (mascota_id) { sql += ' AND v.mascota_id = ?'; params.push(mascota_id); }
    if (proximas)   { sql += ' AND v.proxima_dosis BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)'; }
    sql += ' ORDER BY v.fecha_aplicacion DESC';
    const rows = await req.db.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

router.post('/', auditMiddleware('vacunas:creado', 'vacunas'), async (req, res, next) => {
  try {
    const { mascota_id, nombre, fabricante, lote, fecha_aplicacion, proxima_dosis, notas } = req.body;
    if (!mascota_id || !nombre || !fecha_aplicacion)
      return res.status(422).json({ success: false, message: 'mascota_id, nombre y fecha requeridos.' });
    const result = await req.db.query(
      `INSERT INTO vacunas (mascota_id, veterinario_id, nombre, fabricante, lote, fecha_aplicacion, proxima_dosis, notas)
       VALUES (?,?,?,?,?,?,?,?)`,
      [mascota_id, req.user.id, nombre, fabricante||null, lote||null, fecha_aplicacion, proxima_dosis||null, notas||null]
    );
    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) { next(err); }
});

router.put('/:id', auditMiddleware('vacunas:actualizado', 'vacunas'), async (req, res, next) => {
  try {
    const [_ant] = await req.db.query('SELECT * FROM vacunas WHERE id=?', [req.params.id]).catch(()=>[null]);
    if (_ant) auditLog(req, res, null, null, { anterior: _ant });
    const { nombre, fabricante, lote, fecha_aplicacion, proxima_dosis, notas } = req.body;
    await req.db.query(
      `UPDATE vacunas SET nombre=?, fabricante=?, lote=?, fecha_aplicacion=?, proxima_dosis=?, notas=?
       WHERE id=?`,
      [nombre, fabricante||null, lote||null, fecha_aplicacion, proxima_dosis||null, notas||null, req.params.id]
    );
    return res.json({ success: true, message: 'Vacuna actualizada.' });
  } catch (err) { next(err); }
});

module.exports = router;