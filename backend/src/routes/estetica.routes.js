'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/auth.middleware');
const { auditLog, auditMiddleware, auditAuth } = require('../middlewares/audit.middleware');


const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { mascota_id, fecha } = req.query;
    let sql = `SELECT s.*, m.nombre AS mascota_nombre, m.especie,
                      CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
                      u.nombre AS atendido_por_nombre
               FROM servicios_estetica s
               JOIN mascotas m ON m.id = s.mascota_id
               JOIN propietarios p ON p.id = m.propietario_id
               JOIN usuarios u ON u.id = s.atendido_por_id
               WHERE 1=1`;
    const params = [];
    if (mascota_id) { sql += ' AND s.mascota_id = ?';   params.push(mascota_id); }
    if (fecha)      { sql += ' AND s.fecha = ?';         params.push(fecha); }
    sql += ' ORDER BY s.fecha DESC, s.created_at DESC';
    const rows = await req.db.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

router.post('/', auditMiddleware('estetica:creado', 'estetica'), async (req, res, next) => {
  try {
    const { mascota_id, cita_id, fecha, tipo_bano, incluye_corte, incluye_unas,
            incluye_dental, productos, precio, observaciones } = req.body;
    if (!mascota_id || !fecha)
      return res.status(422).json({ success: false, message: 'mascota_id y fecha requeridos.' });
    const result = await req.db.query(
      `INSERT INTO servicios_estetica
         (mascota_id, atendido_por_id, cita_id, fecha, tipo_bano,
          incluye_corte, incluye_unas, incluye_dental, productos, precio, observaciones)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [mascota_id, req.user.id, cita_id||null, fecha, tipo_bano||'basico',
       incluye_corte?1:0, incluye_unas?1:0, incluye_dental?1:0,
       productos||null, precio||null, observaciones||null]
    );
    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) { next(err); }
});

router.put('/:id', auditMiddleware('estetica:actualizado', 'estetica'), async (req, res, next) => {
  try {
    const [_ant] = await req.db.query('SELECT * FROM servicios_estetica WHERE id=?', [req.params.id]).catch(()=>[null]);
    if (_ant) auditLog(req, res, null, null, { anterior: _ant });
    const { fecha, tipo_bano, incluye_corte, incluye_unas,
            incluye_dental, productos, precio, observaciones } = req.body;
    await req.db.query(
      `UPDATE servicios_estetica SET fecha=?, tipo_bano=?, incluye_corte=?,
        incluye_unas=?, incluye_dental=?, productos=?, precio=?, observaciones=?
       WHERE id=?`,
      [fecha, tipo_bano||'basico', incluye_corte?1:0, incluye_unas?1:0,
       incluye_dental?1:0, productos||null, precio||null, observaciones||null, req.params.id]
    );
    return res.json({ success: true, message: 'Servicio actualizado.' });
  } catch (err) { next(err); }
});

module.exports = router;