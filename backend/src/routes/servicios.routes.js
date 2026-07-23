'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditLog, auditMiddleware, auditAuth } = require('../middlewares/audit.middleware');


const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { categoria, todos } = req.query;
    let sql = 'SELECT * FROM servicios_catalogo WHERE 1=1';
    const params = [];
    if (!todos)    { sql += ' AND activo = 1'; }
    if (categoria) { sql += ' AND categoria = ?'; params.push(categoria); }
    sql += ' ORDER BY categoria, nombre';
    const rows = await req.db.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

router.post('/', authorize('admin'), auditMiddleware('servicios:creado', 'servicios'), async (req, res, next) => {
  try {
    const { nombre, categoria, precio, descripcion } = req.body;
    if (!nombre?.trim()) return res.status(422).json({ success: false, message: 'Nombre obligatorio.' });
    const result = await req.db.query(
      'INSERT INTO servicios_catalogo (nombre, categoria, precio, descripcion) VALUES (?,?,?,?)',
      [nombre.trim(), categoria||'consulta', parseFloat(precio)||0, descripcion?.trim()||null]
    );
    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) { next(err); }
});

router.put('/:id', authorize('admin'), auditMiddleware('servicios:actualizado', 'servicios'), async (req, res, next) => {
  try {
    const [_ant] = await req.db.query('SELECT * FROM servicios_catalogo WHERE id=?', [req.params.id]).catch(()=>[null]);
    if (_ant) auditLog(req, res, null, null, { anterior: _ant });
    const { nombre, categoria, precio, descripcion, activo } = req.body;
    await req.db.query(
      'UPDATE servicios_catalogo SET nombre=?, categoria=?, precio=?, descripcion=?, activo=? WHERE id=?',
      [nombre?.trim(), categoria, parseFloat(precio)||0, descripcion?.trim()||null, activo?1:0, req.params.id]
    );
    return res.json({ success: true, message: 'Servicio actualizado.' });
  } catch (err) { next(err); }
});

router.delete('/:id', authorize('admin'), auditMiddleware('servicios:eliminado', 'servicios'), async (req, res, next) => {
  try {
    const [_ant] = await req.db.query('SELECT * FROM servicios_catalogo WHERE id=?', [req.params.id]).catch(()=>[null]);
    if (_ant) auditLog(req, res, null, null, { anterior: _ant });
    await req.db.query('UPDATE servicios_catalogo SET activo=0 WHERE id=?', [req.params.id]);
    return res.json({ success: true, message: 'Servicio desactivado.' });
  } catch (err) { next(err); }
});

module.exports = router;