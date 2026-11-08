'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');
const { emitirSala } = require('../sockets/emitir');

const { filtroSede, sedeEscritura, sedeDestino, exigirAcceso } = require('../services/sede.service');

const router = Router();
router.use(authenticate);

// ── GET /api/v1/inventario ────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { categoria, bajo, search, vencimiento, page = 1, limit = 50 } = req.query;
    const limitN  = Math.min(parseInt(limit) || 50, 500);
    const offsetN = (Math.max(parseInt(page) || 1, 1) - 1) * limitN;

    let where  = 'WHERE 1=1';
    const params = [];

    const fs = filtroSede(req, 'i.sede_id');
    where += ` ${fs.sql}`; params.push(...fs.params);
    if (categoria)    { where += ' AND i.categoria = ?';             params.push(categoria); }
    if (bajo === '1') { where += ' AND i.cantidad < i.stock_minimo'; }
    if (search)       { where += ' AND i.nombre LIKE ?';             params.push(`%${search}%`); }

    // Filtro por vencimiento
    if (vencimiento === 'vencidos') {
      where += ' AND i.fecha_vencimiento IS NOT NULL AND i.fecha_vencimiento < CURDATE()';
    } else if (vencimiento === 'proximo') {
      where += ' AND i.fecha_vencimiento IS NOT NULL AND i.fecha_vencimiento >= CURDATE() AND i.fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)';
    } else if (vencimiento === 'sin') {
      where += ' AND i.fecha_vencimiento IS NULL';
    }

    const [{ total }] = await req.db.query(
      `SELECT COUNT(*) AS total FROM inventario i ${where}`, params
    );

    const rows = await req.db.query(
      `SELECT i.*, s.nombre AS sede_nombre,
              -- Ganancia por unidad
              CASE WHEN i.precio_unitario > 0 AND i.precio_compra > 0
                   THEN ROUND(i.precio_unitario - i.precio_compra, 2)
                   ELSE NULL END AS ganancia_unit,
              -- Margen %
              CASE WHEN i.precio_unitario > 0 AND i.precio_compra > 0
                   THEN ROUND((i.precio_unitario - i.precio_compra) / i.precio_unitario * 100, 2)
                   ELSE NULL END AS margen_pct
       FROM inventario i
       LEFT JOIN sedes s ON s.id = i.sede_id
       ${where}
       ORDER BY i.nombre ASC
       LIMIT ${limitN} OFFSET ${offsetN}`,
      params
    );

    return res.json({
      success: true,
      data   : rows,
      meta   : { total, page: parseInt(page)||1, limit: limitN, pages: Math.ceil(total/limitN) },
    });
  } catch (err) { next(err); }
});

// ── GET /api/v1/inventario/alertas-vencimiento ────────────────────
// Para el dashboard: cuántos vencidos y por vencer
router.get('/alertas-vencimiento', async (req, res, next) => {
  try {
    const { sql: sf, params: p } = filtroSede(req, 'sede_id');

    const [vencidos] = await req.db.query(
      `SELECT COUNT(*) AS total FROM inventario
       WHERE fecha_vencimiento IS NOT NULL
         AND fecha_vencimiento < CURDATE()
         AND cantidad > 0 ${sf}`, p
    );
    const [proximos] = await req.db.query(
      `SELECT COUNT(*) AS total FROM inventario
       WHERE fecha_vencimiento IS NOT NULL
         AND fecha_vencimiento >= CURDATE()
         AND fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
         AND cantidad > 0 ${sf}`, p
    );

    // Top 5 más urgentes
    const urgentes = await req.db.query(
      `SELECT id, nombre, cantidad, unidad, fecha_vencimiento,
              DATEDIFF(fecha_vencimiento, CURDATE()) AS dias_restantes
       FROM inventario
       WHERE fecha_vencimiento IS NOT NULL
         AND fecha_vencimiento >= CURDATE()
         AND fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
         AND cantidad > 0 ${sf}
       ORDER BY fecha_vencimiento ASC
       LIMIT 5`, p
    );

    return res.json({
      success: true,
      data: {
        vencidos : parseInt(vencidos.total),
        proximos : parseInt(proximos.total),
        urgentes,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /api/v1/inventario/:id ────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const [row] = await req.db.query(
      `SELECT i.*, s.nombre AS sede_nombre,
              CASE WHEN i.precio_unitario > 0 AND i.precio_compra > 0
                   THEN ROUND(i.precio_unitario - i.precio_compra, 2) ELSE NULL END AS ganancia_unit,
              CASE WHEN i.precio_unitario > 0 AND i.precio_compra > 0
                   THEN ROUND((i.precio_unitario - i.precio_compra) / i.precio_unitario * 100, 2) ELSE NULL END AS margen_pct
       FROM inventario i
       LEFT JOIN sedes s ON s.id = i.sede_id
       WHERE i.id = ?`, [req.params.id]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Ítem no encontrado.' });
    exigirAcceso(req, row.sede_id);
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

// ── POST /api/v1/inventario/bulk ──────────────────────────────────
router.post('/bulk', authorize('admin', 'veterinario', 'recepcionista'), async (req, res, next) => {
  try {
    const { items = [] } = req.body;
    if (!items.length)       return res.status(422).json({ success: false, message: 'No se enviaron items.' });
    if (items.length > 10000) return res.status(422).json({ success: false, message: 'Máximo 10,000 items.' });

    const sedeId    = sedeEscritura(req);
    const catValidas = ['medicamento','vacuna','insumo','alimento','accesorio','otro'];
    const validos = []; const errores = [];

    items.forEach((item, idx) => {
      const nombre = String(item.nombre || '').trim();
      if (!nombre) { errores.push(`Fila ${idx+2}: nombre vacío`); return; }
      validos.push([
        nombre,
        catValidas.includes(item.categoria) ? item.categoria : 'otro',
        parseFloat(item.cantidad)        || 0,
        String(item.unidad || 'unidad').trim(),
        parseFloat(item.stock_minimo)    || 5,
        parseFloat(item.precio_unitario) || null,
        parseFloat(item.precio_compra)   || 0,
        String(item.proveedor || '').trim() || null,
        item.fecha_vencimiento || null,
        sedeId,
      ]);
    });

    if (!validos.length) return res.status(422).json({ success: false, message: 'Ningún item válido.', errores });

    const LOTE = 500; let insertados = 0;
    for (let i=0; i<validos.length; i+=LOTE) {
      const lote = validos.slice(i, i+LOTE);
      await req.db.query(
        `INSERT INTO inventario
           (nombre, categoria, cantidad, unidad, stock_minimo,
            precio_unitario, precio_compra, proveedor, fecha_vencimiento, sede_id)
         VALUES ${lote.map(()=>'(?,?,?,?,?,?,?,?,?,?)').join(',')}`,
        lote.flat()
      );
      insertados += lote.length;
    }

    return res.status(201).json({
      success: true,
      message: `✅ ${insertados} productos importados.`,
      data: { insertados, errores: errores.length, detalles_errores: errores.slice(0,20) },
    });
  } catch (err) { next(err); }
});

// ── POST /api/v1/inventario ───────────────────────────────────────
// ── Campos del Punto de Venta (código de barras / favorito) ───────
// Van en un UPDATE aparte: si la clínica aún no tiene la migración,
// el inventario sigue funcionando y estos campos simplemente se ignoran.
async function guardarCamposPV(db, id, codigo_barras, favorito) {
  if (codigo_barras === undefined && favorito === undefined) return;
  try {
    const sets = [], vals = [];
    if (codigo_barras !== undefined) {
      sets.push('codigo_barras = ?');
      vals.push(String(codigo_barras || '').trim().slice(0, 50) || null);
    }
    if (favorito !== undefined) { sets.push('favorito = ?'); vals.push(favorito ? 1 : 0); }
    await db.query(`UPDATE inventario SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }
}

router.post('/', authorize('admin','veterinario','recepcionista'), auditMiddleware('inventario:creado','inventario'), async (req, res, next) => {
  try {
    const {
      nombre, categoria = 'medicamento', cantidad = 0, unidad = 'unidad',
      stock_minimo = 5, precio_unitario = null, precio_compra = 0,
      proveedor = null, fecha_vencimiento = null, descripcion = null,
      sede_id = null,
      codigo_barras, favorito,          // ← NUEVO: Punto de Venta
    } = req.body;

    if (!nombre?.trim()) return res.status(422).json({ success: false, message: 'Nombre obligatorio.' });

    const sedeId = sedeDestino(req, sede_id);

    const result = await req.db.query(
      `INSERT INTO inventario
         (nombre, categoria, cantidad, unidad, stock_minimo,
          precio_unitario, precio_compra, proveedor, fecha_vencimiento, descripcion, sede_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [nombre.trim(), categoria, parseFloat(cantidad)||0, unidad,
       parseFloat(stock_minimo)||5, precio_unitario||null,
       parseFloat(precio_compra)||0, proveedor||null,
       fecha_vencimiento||null, descripcion||null, sedeId]
    );

    await guardarCamposPV(req.db, result.insertId, codigo_barras, favorito);

    if (parseFloat(cantidad) < parseFloat(stock_minimo)) {
      const io = req.app.get('io');
      if (io) emitirSala(req, 'sala:admin', 'notif:stock_minimo', { nombre, cantidad, stock_minimo, unidad });
    }

    return res.status(201).json({ success: true, data: { id: result.insertId }, message: 'Ítem creado.' });
  } catch (err) { next(err); }
});

// ── PUT /api/v1/inventario/:id ────────────────────────────────────
router.put('/:id', authorize('admin','veterinario','recepcionista'), auditMiddleware('inventario:actualizado','inventario'), async (req, res, next) => {
  try {
    const {
      nombre, categoria, cantidad, unidad,
      stock_minimo, precio_unitario, precio_compra = 0,
      proveedor, fecha_vencimiento, descripcion, sede_id = null,
      codigo_barras, favorito,          // ← NUEVO: Punto de Venta
    } = req.body;

    if (!nombre?.trim()) return res.status(422).json({ success: false, message: 'Nombre obligatorio.' });

    const [actual] = await req.db.query('SELECT sede_id FROM inventario WHERE id=?', [req.params.id]);
    if (!actual) return res.status(404).json({ success: false, message: 'Ítem no encontrado.' });
    exigirAcceso(req, actual.sede_id);
    const sedeIdPut = sede_id ? sedeDestino(req, sede_id) : (actual.sede_id || sedeEscritura(req));

    await req.db.query(
      `UPDATE inventario SET
         nombre=?, categoria=?, cantidad=?, unidad=?, stock_minimo=?,
         precio_unitario=?, precio_compra=?, proveedor=?,
         fecha_vencimiento=?, descripcion=?, sede_id=?, updated_at=NOW()
       WHERE id=?`,
      [nombre.trim(), categoria||'medicamento',
       parseFloat(cantidad)||0, unidad||'unidad',
       parseFloat(stock_minimo)||5, precio_unitario||null,
       parseFloat(precio_compra)||0, proveedor||null,
       fecha_vencimiento||null, descripcion||null, sedeIdPut, req.params.id]
    );

    await guardarCamposPV(req.db, req.params.id, codigo_barras, favorito);

    const cantF = parseFloat(cantidad)||0;
    const minF  = parseFloat(stock_minimo)||5;
    if (cantF < minF) {
      const io = req.app.get('io');
      if (io) emitirSala(req, 'sala:admin', 'notif:stock_minimo', { nombre, cantidad: cantF, stock_minimo: minF, unidad });
    }

    return res.json({ success: true, message: 'Ítem actualizado.' });
  } catch (err) { next(err); }
});

// ── PATCH /api/v1/inventario/:id — solo stock ────────────────────
router.patch('/:id', authorize('admin','veterinario','recepcionista'), auditMiddleware('inventario:actualizado','inventario'), async (req, res, next) => {
  try {
    const { cantidad } = req.body;
    if (cantidad === undefined || cantidad === null)
      return res.status(422).json({ success: false, message: 'cantidad requerida.' });

    const cantF = parseFloat(cantidad);
    if (isNaN(cantF) || cantF < 0)
      return res.status(422).json({ success: false, message: 'Cantidad inválida.' });

    const [item] = await req.db.query(
      'SELECT nombre, stock_minimo, unidad, sede_id FROM inventario WHERE id=?', [req.params.id]
    );
    if (!item) return res.status(404).json({ success: false, message: 'Ítem no encontrado.' });
    exigirAcceso(req, item.sede_id);

    await req.db.query('UPDATE inventario SET cantidad=?, updated_at=NOW() WHERE id=?', [cantF, req.params.id]);

    if (cantF < parseFloat(item.stock_minimo)) {
      const io = req.app.get('io');
      if (io) emitirSala(req, 'sala:admin', 'notif:stock_minimo', { nombre: item.nombre, cantidad: cantF, stock_minimo: item.stock_minimo, unidad: item.unidad });
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

// ── DELETE /api/v1/inventario/:id ────────────────────────────────
router.delete('/:id', authorize('admin'), auditMiddleware('inventario:eliminado','inventario'), async (req, res, next) => {
  try {
    const [item] = await req.db.query('SELECT sede_id FROM inventario WHERE id=?', [req.params.id]);
    if (item) exigirAcceso(req, item.sede_id);
    await req.db.query('DELETE FROM inventario WHERE id=?', [req.params.id]);
    return res.json({ success: true, message: 'Ítem eliminado.' });
  } catch (err) { next(err); }
});

module.exports = router;