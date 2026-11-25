'use strict';

/**
 * Compras de inventario (comprobantes de proveedor)
 * Base: /api/v1/inventario/compras   (montado ANTES de /inventario para no chocar con /:id)
 *
 * Al registrar una compra, por cada ítem:
 *   · suma la cantidad al stock del producto,
 *   · recalcula su costo (precio_compra) con promedio ponderado:
 *       nuevo = (stock_anterior × costo_anterior + cantidad × costo_compra) / (stock_anterior + cantidad)
 *   · actualiza el proveedor y, si se indica, la fecha de vencimiento.
 *
 * El costo que entra al inventario es CON IGV: así es comparable con los precios de venta
 * (que incluyen IGV) en el margen del inventario y en el reporte de rentabilidad.
 * Requiere la migración v23 (tablas compras / compras_detalle).
 */

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');
const { emitirSala } = require('../sockets/emitir');
const { filtroSede, exigirAcceso } = require('../services/sede.service');

const router = Router();
router.use(authenticate);

const TIPOS      = ['factura', 'boleta', 'nota_venta', 'guia', 'otro'];
const MODOS_IGV  = ['sin_igv', 'con_igv', 'no_afecto'];
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;

const sinMigracion = (res) => res.status(503).json({
  success: false, code: 'SIN_MIGRACION',
  message: 'El módulo de compras aún no está habilitado en esta clínica (falta la migración v23).',
});

// ── GET /api/v1/inventario/compras ────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { desde, hasta, search, page = 1, limit = 20 } = req.query;
    const limitN  = Math.min(parseInt(limit) || 20, 100);
    const offsetN = (Math.max(parseInt(page) || 1, 1) - 1) * limitN;

    const fs = filtroSede(req, 'c.sede_id');
    let where = `WHERE 1=1 ${fs.sql}`;
    const params = [...fs.params];
    if (/^\d{4}-\d{2}-\d{2}$/.test(desde || '')) { where += ' AND c.fecha_emision >= ?'; params.push(desde); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(hasta || '')) { where += ' AND c.fecha_emision <= ?'; params.push(hasta); }
    if (search?.trim()) {
      const like = `%${search.trim()}%`;
      where += ' AND (c.proveedor_nombre LIKE ? OR c.proveedor_ruc LIKE ? OR CONCAT_WS(\'-\', c.serie, c.numero) LIKE ?)';
      params.push(like, like, like);
    }

    const [{ total }] = await req.db.query(`SELECT COUNT(*) AS total FROM compras c ${where}`, params);
    const rows = await req.db.query(
      `SELECT c.*, DATE_FORMAT(c.fecha_emision, '%Y-%m-%d') AS fecha_emision,
              s.nombre AS sede_nombre, u.nombre AS registrado_por,
              (SELECT COUNT(*) FROM compras_detalle d WHERE d.compra_id = c.id) AS total_items
       FROM compras c
       LEFT JOIN sedes s    ON s.id = c.sede_id
       LEFT JOIN usuarios u ON u.id = c.registrado_por_id
       ${where}
       ORDER BY c.fecha_emision DESC, c.id DESC
       LIMIT ${limitN} OFFSET ${offsetN}`,
      params
    );
    return res.json({ success: true, data: rows, meta: { total, page: parseInt(page) || 1, limit: limitN } });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return sinMigracion(res);
    next(err);
  }
});

// ── GET /api/v1/inventario/compras/:id ────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const [compra] = await req.db.query(
      `SELECT c.*, DATE_FORMAT(c.fecha_emision, '%Y-%m-%d') AS fecha_emision,
              s.nombre AS sede_nombre, u.nombre AS registrado_por
       FROM compras c
       LEFT JOIN sedes s    ON s.id = c.sede_id
       LEFT JOIN usuarios u ON u.id = c.registrado_por_id
       WHERE c.id = ?`, [req.params.id]
    );
    if (!compra) return res.status(404).json({ success: false, message: 'Compra no encontrada.' });
    exigirAcceso(req, compra.sede_id);

    const items = await req.db.query(
      `SELECT d.*, DATE_FORMAT(d.fecha_vencimiento, '%Y-%m-%d') AS fecha_vencimiento, i.unidad
       FROM compras_detalle d LEFT JOIN inventario i ON i.id = d.inventario_id
       WHERE d.compra_id = ? ORDER BY d.id`, [req.params.id]
    );
    return res.json({ success: true, data: { ...compra, items } });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return sinMigracion(res);
    next(err);
  }
});

// ── POST /api/v1/inventario/compras ───────────────────────────────
router.post('/', authorize('admin', 'veterinario', 'recepcionista'),
  auditMiddleware('inventario:compra_registrada', 'inventario'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const txt = (v, max) => (v === undefined || v === null) ? null : (String(v).trim().slice(0, max) || null);

    const tipo        = TIPOS.includes(b.tipo_comprobante) ? b.tipo_comprobante : 'factura';
    const modoIgv     = MODOS_IGV.includes(b.modo_igv) ? b.modo_igv : 'sin_igv';
    const serie       = txt(b.serie, 10)?.toUpperCase() || null;
    const numero      = txt(b.numero, 20);
    const fecha       = String(b.fecha_emision || '');
    const provRuc     = txt(b.proveedor_ruc, 11);
    const provNombre  = txt(b.proveedor_nombre, 200);
    const obs         = txt(b.observaciones, 255);
    const itemsIn     = Array.isArray(b.items) ? b.items : [];

    const error = (m) => res.status(422).json({ success: false, message: m });
    if (!numero)                            return error('Ingresa el número del comprobante.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return error('Ingresa la fecha de emisión.');
    if (!provNombre)                        return error('Ingresa el nombre del proveedor.');
    if (provRuc && !/^\d{11}$/.test(provRuc)) return error('El RUC del proveedor debe tener 11 dígitos.');
    if (tipo === 'factura' && !provRuc)     return error('Para una factura ingresa el RUC del proveedor.');
    if (!itemsIn.length)                    return error('Agrega al menos un producto.');
    if (itemsIn.length > 200)               return error('Máximo 200 ítems por compra.');

    const items = [];
    for (let i = 0; i < itemsIn.length; i++) {
      const it   = itemsIn[i] || {};
      const id   = parseInt(it.inventario_id, 10);
      const cant = parseFloat(it.cantidad);
      const pu   = parseFloat(it.precio_unitario);
      const venc = /^\d{4}-\d{2}-\d{2}$/.test(it.fecha_vencimiento || '') ? it.fecha_vencimiento : null;
      const lote = txt(it.lote, 50);
      if (!id)                                   return error(`Ítem ${i + 1}: selecciona un producto del inventario.`);
      if (!Number.isFinite(cant) || cant <= 0)   return error(`Ítem ${i + 1}: la cantidad debe ser mayor a 0.`);
      if (!Number.isFinite(pu) || pu < 0)        return error(`Ítem ${i + 1}: precio unitario inválido.`);
      items.push({ id, cant: r2(cant), pu: r4(pu), venc, lote });
    }

    // Comprobante repetido (mismo proveedor + tipo + serie + número)
    const [dup] = await req.db.query(
      `SELECT id FROM compras
       WHERE tipo_comprobante = ? AND COALESCE(serie,'') = ? AND numero = ?
         AND ${provRuc ? 'proveedor_ruc = ?' : 'proveedor_nombre = ?'}`,
      [tipo, serie || '', numero, provRuc || provNombre]
    );
    if (dup) return res.status(409).json({
      success: false, code: 'COMPRA_DUPLICADA', data: { id: dup.id },
      message: `Ese comprobante (${serie ? serie + '-' : ''}${numero}) de este proveedor ya fue registrado.`,
    });

    const [cfg] = await req.db.query('SELECT igv_porcentaje FROM empresa_config LIMIT 1');
    const igvPct = cfg?.igv_porcentaje != null ? parseFloat(cfg.igv_porcentaje) : 18;
    const factorIgv = 1 + igvPct / 100;

    const resultado = await req.db.withTransaction(async (conn) => {
      const q = async (sql, p) => (await conn.execute(sql, p))[0];

      // Bloquea los productos para que el stock y el promedio no se pisen con otra operación
      const ids  = [...new Set(items.map(i => i.id))];
      const prods = await q(
        `SELECT id, nombre, cantidad, precio_compra, sede_id, unidad, lote,
                DATE_FORMAT(fecha_vencimiento, '%Y-%m-%d') AS fecha_vencimiento
         FROM inventario WHERE id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`, ids
      );
      const porId = Object.fromEntries(prods.map(p => [p.id, p]));

      let sedeId = null;
      for (const it of items) {
        const p = porId[it.id];
        if (!p) throw Object.assign(new Error('Uno de los productos ya no existe en el inventario.'), { status: 422 });
        exigirAcceso(req, p.sede_id);
        if (p.sede_id) {
          if (sedeId && sedeId !== p.sede_id)
            throw Object.assign(new Error('Todos los productos de una compra deben ser de la misma sede.'), { status: 422 });
          sedeId = p.sede_id;
        }
      }
      if (!sedeId) sedeId = req.sede?.activa || null;

      // Totales del comprobante
      const bruto = r2(items.reduce((a, it) => a + it.cant * it.pu, 0));
      let subtotal, igv, total;
      if (modoIgv === 'sin_igv')      { subtotal = bruto; igv = r2(bruto * igvPct / 100); total = r2(subtotal + igv); }
      else if (modoIgv === 'con_igv') { total = bruto; subtotal = r2(bruto / factorIgv); igv = r2(total - subtotal); }
      else                            { subtotal = bruto; igv = 0; total = bruto; }

      const [r] = await conn.execute(
        `INSERT INTO compras (sede_id, tipo_comprobante, serie, numero, fecha_emision, proveedor_ruc,
           proveedor_nombre, modo_igv, igv_porcentaje, subtotal, igv, total, observaciones, registrado_por_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [sedeId, tipo, serie, numero, fecha, provRuc, provNombre, modoIgv, igvPct,
         subtotal, igv, total, obs, req.user.id]
      );
      const compraId = r.insertId;

      const actualizados = [];
      for (const it of items) {
        const p = porId[it.id];
        const stockAnt = parseFloat(p.cantidad) || 0;
        const costoAnt = parseFloat(p.precio_compra) || 0;
        const costoUnit = modoIgv === 'sin_igv' ? it.pu * factorIgv : it.pu;   // costo con IGV

        // Promedio ponderado. Si no había stock (o no tenía costo) el costo es el de esta compra.
        const base = Math.max(stockAnt, 0);
        const costoProm = (base > 0 && costoAnt > 0)
          ? (base * costoAnt + it.cant * costoUnit) / (base + it.cant)
          : costoUnit;

        // Vencimiento y lote van juntos: si el stock previo vence antes, se conserva esa fecha
        // y su lote (la alerta de vencimiento sigue siendo válida).
        const ant = p.fecha_vencimiento || null;
        const conservaAnterior = !!(it.venc && stockAnt > 0 && ant && ant < it.venc);
        const venc = it.venc ? (conservaAnterior ? ant : it.venc) : ant;
        const lote = (it.lote && !conservaAnterior) ? it.lote : (p.lote || null);

        const nuevoStock = r2(stockAnt + it.cant);
        await conn.execute(
          `UPDATE inventario SET cantidad = ?, precio_compra = ?, proveedor = ?, fecha_vencimiento = ?, lote = ?,
             updated_at = NOW()
           WHERE id = ?`,
          [nuevoStock, r2(costoProm), provNombre.slice(0, 150), venc || null, lote, it.id]
        );
        await conn.execute(
          `INSERT INTO compras_detalle (compra_id, inventario_id, descripcion, cantidad, precio_unitario,
             costo_unitario, subtotal, lote, fecha_vencimiento, stock_anterior, costo_anterior, costo_promedio)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [compraId, it.id, p.nombre, it.cant, it.pu, r4(costoUnit), r2(it.cant * it.pu), it.lote, it.venc,
           r2(stockAnt), r2(costoAnt), r2(costoProm)]
        );

        // Si el mismo producto aparece en dos líneas, la segunda parte del resultado de la primera
        p.cantidad = nuevoStock; p.precio_compra = r2(costoProm); p.fecha_vencimiento = venc; p.lote = lote;
        actualizados.push({ id: p.id, nombre: p.nombre, cantidad: nuevoStock, unidad: p.unidad,
                            costo_anterior: r2(costoAnt), costo_promedio: r2(costoProm) });
      }
      return { id: compraId, subtotal, igv, total, productos: actualizados };
    });

    // Un aviso por producto (si vino en varias líneas, con el estado final)
    const finales = new Map(resultado.productos.map(p => [p.id, p]));
    for (const p of finales.values()) {
      const payload = { id: p.id, nombre: p.nombre, cantidad: p.cantidad, unidad: p.unidad };
      emitirSala(req, 'sala:admin', 'inventario:actualizado', payload);
      emitirSala(req, 'sala:veterinarios', 'inventario:actualizado', payload);
      emitirSala(req, 'sala:recepcionistas', 'inventario:actualizado', payload);
    }

    return res.status(201).json({
      success: true,
      message: `✅ Compra registrada: ${items.length} ítem${items.length > 1 ? 's' : ''} ingresados al inventario.`,
      data: resultado,
    });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return sinMigracion(res);
    if (err.status === 422) return res.status(422).json({ success: false, message: err.message });
    next(err);
  }
});

module.exports = router;
