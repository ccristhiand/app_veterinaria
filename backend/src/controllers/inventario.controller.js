'use strict';

const { query }            = require('../config/database');
const { emitirAlertaStock } = require('../sockets');
const logger               = require('../config/logger');

async function listar(req, res, next) {
  try {
    const rows = await query(
      `SELECT *, (cantidad <= stock_minimo) AS bajo_stock
       FROM inventario ORDER BY nombre`,
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
}

async function actualizar(req, res, next) {
  try {
    const { cantidad } = req.body;
    const { id } = req.params;

    if (typeof cantidad !== 'number' || cantidad < 0) {
      return res.status(422).json({ success: false, message: 'Cantidad inválida.' });
    }

    await query('UPDATE inventario SET cantidad = ? WHERE id = ?', [cantidad, id]);

    // Verificar si quedó bajo el mínimo y emitir alerta
    const [item] = await query('SELECT * FROM inventario WHERE id = ?', [id]);
    if (item && item.cantidad <= item.stock_minimo) {
      const io = req.app.get('io');
      await emitirAlertaStock(io, item);
      logger.warn(`⚠️  Stock bajo: ${item.nombre} (${item.cantidad} ${item.unidad})`);
    }

    return res.json({ success: true, data: item });
  } catch (err) { next(err); }
}

async function crear(req, res, next) {
  try {
    const { nombre, categoria, cantidad, unidad, stock_minimo, precio_unitario, proveedor, notas } = req.body;
    const result = await query(
      `INSERT INTO inventario (nombre, categoria, cantidad, unidad, stock_minimo, precio_unitario, proveedor, notas)
       VALUES (?,?,?,?,?,?,?,?)`,
      [nombre, categoria || 'insumo', cantidad || 0, unidad || 'unidad',
       stock_minimo || 5, precio_unitario || null, proveedor || null, notas || null],
    );
    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) { next(err); }
}

module.exports = { listar, actualizar, crear };
