'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditLog, auditMiddleware, auditAuth } = require('../middlewares/audit.middleware');


const router = Router();
router.use(authenticate);

// ── GET /api/v1/inventario ────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { categoria, bajo } = req.query;
    let sql = 'SELECT * FROM inventario WHERE 1=1';
    const params = [];
    if (categoria) { sql += ' AND categoria=?'; params.push(categoria); }
    if (bajo === '1') { sql += ' AND cantidad < stock_minimo'; }
    sql += ' ORDER BY nombre ASC';
    const rows = await req.db.query(sql, params);
    return res.json({ success:true, data:rows });
  } catch(err) { next(err); }
});

// ── GET /api/v1/inventario/:id ────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const [row] = await req.db.query('SELECT * FROM inventario WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ success:false, message:'Ítem no encontrado.' });
    return res.json({ success:true, data:row });
  } catch(err) { next(err); }
});

// ── POST /api/v1/inventario — crear ítem ──────────────────────────
router.post('/', authorize('admin','veterinario','recepcionista'), auditMiddleware('inventario:creado', 'inventario'), async (req, res, next) => {
  try {
    const {
      nombre, categoria='medicamento', cantidad=0, unidad='unidad',
      stock_minimo=5, precio_unitario=null, proveedor=null,
      fecha_vencimiento=null, descripcion=null,
    } = req.body;

    if (!nombre?.trim())
      return res.status(422).json({ success:false, message:'Nombre obligatorio.' });

    const result = await req.db.query(
      `INSERT INTO inventario
         (nombre, categoria, cantidad, unidad, stock_minimo,
          precio_unitario, proveedor, fecha_vencimiento, descripcion)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [nombre.trim(), categoria, parseFloat(cantidad)||0, unidad,
       parseFloat(stock_minimo)||5, precio_unitario||null,
       proveedor||null, fecha_vencimiento||null, descripcion||null]
    );

    // Verificar alerta de stock
    if (parseFloat(cantidad) < parseFloat(stock_minimo)) {
      const io = req.app.get('io');
      if (io) io.to('sala:admin').emit('notif:stock_minimo', {
        nombre, cantidad, stock_minimo, unidad,
      });
    }

    return res.status(201).json({ success:true, data:{ id:result.insertId }, message:'Ítem creado.' });
  } catch(err) { next(err); }
});

// ── PUT /api/v1/inventario/:id — editar ítem completo ─────────────
router.put('/:id', authorize('admin','veterinario','recepcionista'), auditMiddleware('inventario:actualizado', 'inventario'), async (req, res, next) => {
  try {
    const [_ant] = await req.db.query('SELECT * FROM inventario WHERE id=?', [req.params.id]).catch(()=>[null]);
    if (_ant) auditLog(req, res, null, null, { anterior: _ant });
    const {
      nombre, categoria, cantidad, unidad,
      stock_minimo, precio_unitario, proveedor,
      fecha_vencimiento, descripcion,
    } = req.body;

    if (!nombre?.trim())
      return res.status(422).json({ success:false, message:'Nombre obligatorio.' });

    await req.db.query(
      `UPDATE inventario SET
         nombre=?, categoria=?, cantidad=?, unidad=?, stock_minimo=?,
         precio_unitario=?, proveedor=?, fecha_vencimiento=?, descripcion=?,
         updated_at=NOW()
       WHERE id=?`,
      [nombre.trim(), categoria||'medicamento',
       parseFloat(cantidad)||0, unidad||'unidad',
       parseFloat(stock_minimo)||5, precio_unitario||null,
       proveedor||null, fecha_vencimiento||null, descripcion||null,
       req.params.id]
    );

    // Verificar alerta de stock
    const cantF = parseFloat(cantidad) || 0;
    const minF  = parseFloat(stock_minimo) || 5;
    if (cantF < minF && minF > 0) {
      const io = req.app.get('io');
      if (io) io.to('sala:admin').emit('notif:stock_minimo', {
        nombre, cantidad:cantF, stock_minimo:minF, unidad,
      });
    }

    return res.json({ success:true, message:'Ítem actualizado.' });
  } catch(err) { next(err); }
});

// ── PATCH /api/v1/inventario/:id — actualizar solo stock ──────────
router.patch('/:id', authorize('admin','veterinario','recepcionista'), auditMiddleware('inventario:actualizado', 'inventario'), async (req, res, next) => {
  try {
    const [_ant] = await req.db.query('SELECT * FROM inventario WHERE id=?', [req.params.id]).catch(()=>[null]);
    if (_ant) auditLog(req, res, null, null, { anterior: _ant });
    const { cantidad } = req.body;
    if (cantidad === undefined || cantidad === null)
      return res.status(422).json({ success:false, message:'cantidad requerida.' });

    const cantF = parseFloat(cantidad);
    if (isNaN(cantF) || cantF < 0)
      return res.status(422).json({ success:false, message:'Cantidad inválida.' });

    // Obtener datos actuales
    const [item] = await req.db.query(
      'SELECT nombre, stock_minimo, unidad FROM inventario WHERE id=?',
      [req.params.id]
    );
    if (!item) return res.status(404).json({ success:false, message:'Ítem no encontrado.' });

    await req.db.query(
      'UPDATE inventario SET cantidad=?, updated_at=NOW() WHERE id=?',
      [cantF, req.params.id]
    );

    // Emitir alerta si queda bajo mínimo
    if (cantF < parseFloat(item.stock_minimo)) {
      const io = req.app.get('io');
      if (io) {
        io.to('sala:admin').emit('notif:stock_minimo', {
          nombre      : item.nombre,
          cantidad    : cantF,
          stock_minimo: item.stock_minimo,
          unidad      : item.unidad,
        });
      }

      // Guardar notificación en BD
      const admins = await req.db.query(
        "SELECT id FROM usuarios WHERE rol='admin' AND activo=1"
      );
      for (const admin of admins) {
        await req.db.query(
          `INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje)
           VALUES (?, 'stock_minimo', '⚠️ Stock bajo', ?)`,
          [admin.id, `${item.nombre} tiene solo ${cantF} ${item.unidad} (mínimo: ${item.stock_minimo})`]
        );
      }
    }

    return res.json({
      success  : true,
      message  : '✅ Stock actualizado.',
      data     : {
        id          : parseInt(req.params.id),
        cantidad    : cantF,
        stock_minimo: item.stock_minimo,
        alerta      : cantF < parseFloat(item.stock_minimo),
      },
    });
  } catch(err) { next(err); }
});

// ── DELETE /api/v1/inventario/:id — eliminar ítem ─────────────────
router.delete('/:id', authorize('admin'), auditMiddleware('inventario:eliminado', 'inventario'), async (req, res, next) => {
  try {
    const [_ant] = await req.db.query('SELECT * FROM inventario WHERE id=?', [req.params.id]).catch(()=>[null]);
    if (_ant) auditLog(req, res, null, null, { anterior: _ant });
    await req.db.query('DELETE FROM inventario WHERE id=?', [req.params.id]);
    return res.json({ success:true, message:'Ítem eliminado.' });
  } catch(err) { next(err); }
});

module.exports = router;