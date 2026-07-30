'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');

const router = Router();
router.use(authenticate);

// ── Helper: filtro de sede ────────────────────────────────────────
function getSedeFiltro(req) {
  const user   = req.user;
  const header = req.headers['x-sede-id'] ? parseInt(req.headers['x-sede-id']) : null;
  if (user.rol === 'admin') return header || null;
  return user.sede_id || header || null;
}

// Incluye sede_id IS NULL para datos legacy (registros antes de multi-sedes)
function sedeSQL(sedeId, col) {
  col = col || 'sede_id';
  if (!sedeId) return { sql: '', params: [] };
  return {
    sql   : 'AND (' + col + ' = ? OR ' + col + ' IS NULL)',
    params: [sedeId],
  };
}

// ── GET /api/v1/inventario ────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { categoria, bajo } = req.query;
    const sedeId = getSedeFiltro(req);

    let sql = `SELECT i.*, s.nombre AS sede_nombre
               FROM inventario i
               LEFT JOIN sedes s ON s.id = i.sede_id
               WHERE 1=1`;
    const params = [];

    if (sedeId)        { sql += ' AND i.sede_id = ?';          params.push(sedeId); }
    if (categoria)     { sql += ' AND i.categoria = ?';        params.push(categoria); }
    if (bajo === '1')  { sql += ' AND i.cantidad < i.stock_minimo'; }

    sql += ' ORDER BY i.nombre ASC';
    const rows = await req.db.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/v1/inventario/:id ────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const [row] = await req.db.query(
      `SELECT i.*, s.nombre AS sede_nombre
       FROM inventario i
       LEFT JOIN sedes s ON s.id = i.sede_id
       WHERE i.id = ?`, [req.params.id]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Ítem no encontrado.' });
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});


// ── POST /api/v1/inventario/bulk — carga masiva ───────────────────
// Recibe hasta 10,000 items en un solo request y hace INSERT masivo
router.post('/bulk', authorize('admin', 'veterinario', 'recepcionista'), async (req, res, next) => {
  try {
    const { items = [] } = req.body;

    if (!items.length)
      return res.status(422).json({ success: false, message: 'No se enviaron items.' });

    if (items.length > 10000)
      return res.status(422).json({ success: false, message: 'Máximo 10,000 items por carga.' });

    // Sede del usuario
    const sedeId = req.user.sede_id ||
                   (req.headers['x-sede-id'] ? parseInt(req.headers['x-sede-id']) : null);

    const catValidas = ['medicamento','vacuna','insumo','otro'];

    // Validar y limpiar items
    const validos  = [];
    const errores  = [];

    items.forEach((item, idx) => {
      const nombre = String(item.nombre || '').trim();
      if (!nombre) { errores.push(`Fila ${idx + 2}: nombre vacío`); return; }

      const cat = catValidas.includes(item.categoria) ? item.categoria : 'otro';
      validos.push([
        nombre,
        cat,
        parseFloat(item.cantidad)        || 0,
        String(item.unidad || 'unidad').trim(),
        parseFloat(item.stock_minimo)    || 5,
        parseFloat(item.precio_unitario) || null,
        String(item.proveedor || '').trim() || null,
        item.fecha_vencimiento || null,
        sedeId,
      ]);
    });

    if (!validos.length)
      return res.status(422).json({ success: false, message: 'Ningún item válido.', errores });

    // INSERT masivo en lotes de 500 para no saturar MySQL
    const LOTE = 500;
    let insertados = 0;

    for (let i = 0; i < validos.length; i += LOTE) {
      const lote = validos.slice(i, i + LOTE);
      const placeholders = lote.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
      const valores = lote.flat();

      await req.db.query(
        `INSERT INTO inventario
           (nombre, categoria, cantidad, unidad, stock_minimo,
            precio_unitario, proveedor, fecha_vencimiento, sede_id)
         VALUES ${placeholders}`,
        valores
      );
      insertados += lote.length;
    }

    return res.status(201).json({
      success   : true,
      message   : `✅ ${insertados} productos importados correctamente.`,
      data      : { insertados, errores: errores.length, detalles_errores: errores.slice(0, 20) },
    });
  } catch (err) { next(err); }
});

// ── POST /api/v1/inventario — crear ítem ─────────────────────────
router.post('/', authorize('admin', 'veterinario', 'recepcionista'), auditMiddleware('inventario:creado', 'inventario'), async (req, res, next) => {
  try {
    const {
      nombre, categoria = 'medicamento', cantidad = 0, unidad = 'unidad',
      stock_minimo = 5, precio_unitario = null, proveedor = null,
      fecha_vencimiento = null, descripcion = null,
    } = req.body;

    if (!nombre?.trim())
      return res.status(422).json({ success: false, message: 'Nombre obligatorio.' });

    // El ítem se asocia a la sede del usuario que lo crea
    const sedeId = req.user.sede_id ||
                   (req.headers['x-sede-id'] ? parseInt(req.headers['x-sede-id']) : null);

    const result = await req.db.query(
      `INSERT INTO inventario
         (nombre, categoria, cantidad, unidad, stock_minimo,
          precio_unitario, proveedor, fecha_vencimiento, descripcion, sede_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [nombre.trim(), categoria, parseFloat(cantidad) || 0, unidad,
       parseFloat(stock_minimo) || 5, precio_unitario || null,
       proveedor || null, fecha_vencimiento || null, descripcion || null, sedeId]
    );

    if (parseFloat(cantidad) < parseFloat(stock_minimo)) {
      const io = req.app.get('io');
      if (io) io.to('sala:admin').emit('notif:stock_minimo', { nombre, cantidad, stock_minimo, unidad });
    }

    return res.status(201).json({ success: true, data: { id: result.insertId }, message: 'Ítem creado.' });
  } catch (err) { next(err); }
});

// ── PUT /api/v1/inventario/:id — editar ítem completo ────────────
router.put('/:id', authorize('admin', 'veterinario', 'recepcionista'), auditMiddleware('inventario:actualizado', 'inventario'), async (req, res, next) => {
  try {
    const {
      nombre, categoria, cantidad, unidad,
      stock_minimo, precio_unitario, proveedor,
      fecha_vencimiento, descripcion,
    } = req.body;

    if (!nombre?.trim())
      return res.status(422).json({ success: false, message: 'Nombre obligatorio.' });

    await req.db.query(
      `UPDATE inventario SET
         nombre=?, categoria=?, cantidad=?, unidad=?, stock_minimo=?,
         precio_unitario=?, proveedor=?, fecha_vencimiento=?, descripcion=?,
         updated_at=NOW()
       WHERE id=?`,
      [nombre.trim(), categoria || 'medicamento',
       parseFloat(cantidad) || 0, unidad || 'unidad',
       parseFloat(stock_minimo) || 5, precio_unitario || null,
       proveedor || null, fecha_vencimiento || null, descripcion || null,
       req.params.id]
    );

    const cantF = parseFloat(cantidad) || 0;
    const minF  = parseFloat(stock_minimo) || 5;
    if (cantF < minF && minF > 0) {
      const io = req.app.get('io');
      if (io) io.to('sala:admin').emit('notif:stock_minimo', { nombre, cantidad: cantF, stock_minimo: minF, unidad });
    }

    return res.json({ success: true, message: 'Ítem actualizado.' });
  } catch (err) { next(err); }
});

// ── PATCH /api/v1/inventario/:id — actualizar solo stock ─────────
router.patch('/:id', authorize('admin', 'veterinario', 'recepcionista'), auditMiddleware('inventario:actualizado', 'inventario'), async (req, res, next) => {
  try {
    const { cantidad } = req.body;
    if (cantidad === undefined || cantidad === null)
      return res.status(422).json({ success: false, message: 'cantidad requerida.' });

    const cantF = parseFloat(cantidad);
    if (isNaN(cantF) || cantF < 0)
      return res.status(422).json({ success: false, message: 'Cantidad inválida.' });

    const [item] = await req.db.query(
      'SELECT nombre, stock_minimo, unidad FROM inventario WHERE id=?', [req.params.id]
    );
    if (!item) return res.status(404).json({ success: false, message: 'Ítem no encontrado.' });

    await req.db.query('UPDATE inventario SET cantidad=?, updated_at=NOW() WHERE id=?', [cantF, req.params.id]);

    if (cantF < parseFloat(item.stock_minimo)) {
      const io = req.app.get('io');
      if (io) {
        io.to('sala:admin').emit('notif:stock_minimo', {
          nombre: item.nombre, cantidad: cantF, stock_minimo: item.stock_minimo, unidad: item.unidad,
        });
      }
      const admins = await req.db.query("SELECT id FROM usuarios WHERE rol='admin' AND activo=1");
      for (const admin of admins) {
        await req.db.query(
          `INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje) VALUES (?, 'stock_minimo', '⚠️ Stock bajo', ?)`,
          [admin.id, `${item.nombre} tiene solo ${cantF} ${item.unidad} (mínimo: ${item.stock_minimo})`]
        );
      }
    }

    return res.json({
      success: true, message: '✅ Stock actualizado.',
      data: { id: parseInt(req.params.id), cantidad: cantF, stock_minimo: item.stock_minimo, alerta: cantF < parseFloat(item.stock_minimo) },
    });
  } catch (err) { next(err); }
});

// ── DELETE /api/v1/inventario/:id — eliminar ítem ────────────────
router.delete('/:id', authorize('admin'), auditMiddleware('inventario:eliminado', 'inventario'), async (req, res, next) => {
  try {
    await req.db.query('DELETE FROM inventario WHERE id=?', [req.params.id]);
    return res.json({ success: true, message: 'Ítem eliminado.' });
  } catch (err) { next(err); }
});

module.exports = router;