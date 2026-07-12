'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = Router();
router.use(authenticate);
router.use(authorize('admin', 'recepcionista'));

// GET /api/v1/caja/resumen-dia
router.get('/resumen-dia', async (req, res, next) => {
  try {
    const { fecha, turno } = req.query;
    const dia = fecha || new Date().toISOString().split('T')[0];
    const [totales] = await req.db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN fp.metodo_pago='efectivo'      THEN fp.monto ELSE 0 END),0) AS efectivo,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='tarjeta'       THEN fp.monto ELSE 0 END),0) AS tarjeta,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='transferencia' THEN fp.monto ELSE 0 END),0) AS transferencia,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='yape'          THEN fp.monto ELSE 0 END),0) AS yape,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='plin'          THEN fp.monto ELSE 0 END),0) AS plin,
         COALESCE(SUM(fp.monto), 0)  AS total,
         COUNT(DISTINCT f.id)         AS total_documentos
       FROM factura_pagos fp
       JOIN facturas f ON f.id = fp.factura_id
       WHERE f.fecha = ? AND f.estado = 'pagado'`, [dia]
    );
    const [cierreExistente] = await req.db.query(
      `SELECT id, estado, conteo_fisico, diferencia, total_gastos, monto_inicial, observaciones
       FROM caja_cierres WHERE fecha = ? AND turno = ?
       ORDER BY created_at DESC LIMIT 1`,
      [dia, turno || 'dia_completo']
    );
    const [pendientes] = await req.db.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(total),0) AS monto
       FROM facturas WHERE fecha = ? AND estado = 'pendiente'`, [dia]
    );
    let gastos = [];
    if (cierreExistente) {
      gastos = await req.db.query(
        'SELECT * FROM caja_gastos WHERE cierre_id = ? ORDER BY created_at ASC',
        [cierreExistente.id]
      );
    }
    return res.json({
      success: true,
      data: { fecha: dia, turno: turno||'dia_completo', totales, pendientes, cierre_existente: cierreExistente||null, gastos },
    });
  } catch (err) { next(err); }
});

// GET /api/v1/caja/cierres
router.get('/cierres', async (req, res, next) => {
  try {
    const { desde, hasta, page = 1 } = req.query;
    const limit = 20, offset = (parseInt(page)-1) * limit;
    let sql = `SELECT cc.*, u.nombre AS realizado_por FROM caja_cierres cc
               JOIN usuarios u ON u.id = cc.realizado_por_id WHERE 1=1`;
    const params = [];
    if (desde) { sql += ' AND cc.fecha >= ?'; params.push(desde); }
    if (hasta) { sql += ' AND cc.fecha <= ?'; params.push(hasta); }
    sql += ` ORDER BY cc.fecha DESC, cc.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    const rows = await req.db.query(sql, params);
    for (const row of rows) {
      row.gastos = await req.db.query('SELECT * FROM caja_gastos WHERE cierre_id=?', [row.id]);
    }
    return res.json({ success:true, data:rows });
  } catch (err) { next(err); }
});

// GET /api/v1/caja/cierres/:id
router.get('/cierres/:id', async (req, res, next) => {
  try {
    const [cierre] = await req.db.query(
      `SELECT cc.*, u.nombre AS realizado_por FROM caja_cierres cc
       JOIN usuarios u ON u.id = cc.realizado_por_id WHERE cc.id = ?`, [req.params.id]
    );
    if (!cierre) return res.status(404).json({ success:false, message:'No encontrado.' });
    cierre.gastos = await req.db.query('SELECT * FROM caja_gastos WHERE cierre_id=? ORDER BY created_at ASC', [req.params.id]);
    return res.json({ success:true, data:cierre });
  } catch (err) { next(err); }
});

// POST /api/v1/caja/cierres
router.post('/cierres', async (req, res, next) => {
  try {
    const { fecha, turno='dia_completo', monto_inicial=0, conteo_fisico, observaciones, gastos=[], cerrar=false } = req.body;
    if (!fecha) return res.status(422).json({ success:false, message:'fecha requerida.' });
    if (conteo_fisico === undefined || conteo_fisico === null)
      return res.status(422).json({ success:false, message:'conteo_fisico requerido.' });

    const [totales] = await req.db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN fp.metodo_pago='efectivo'      THEN fp.monto ELSE 0 END),0) AS efectivo,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='tarjeta'       THEN fp.monto ELSE 0 END),0) AS tarjeta,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='transferencia' THEN fp.monto ELSE 0 END),0) AS transferencia,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='yape'          THEN fp.monto ELSE 0 END),0) AS yape,
         COALESCE(SUM(CASE WHEN fp.metodo_pago='plin'          THEN fp.monto ELSE 0 END),0) AS plin,
         COALESCE(SUM(fp.monto), 0) AS total
       FROM factura_pagos fp
       JOIN facturas f ON f.id = fp.factura_id
       WHERE f.fecha = ? AND f.estado = 'pagado'`, [fecha]
    );

    const totalGastos      = gastos.reduce((a,g) => a + parseFloat(g.monto||0), 0);
    const efectivoEsperado = parseFloat(monto_inicial) + parseFloat(totales.efectivo) - totalGastos;
    const diferencia       = parseFloat((parseFloat(conteo_fisico) - efectivoEsperado).toFixed(2));

    const result = await req.db.withTransaction(async (conn) => {
      const [[existente]] = await conn.execute(
        'SELECT id, estado FROM caja_cierres WHERE fecha=? AND turno=? ORDER BY created_at DESC LIMIT 1',
        [fecha, turno]
      );
      if (existente?.estado === 'cerrado')
        throw Object.assign(new Error('Ya existe un cierre definitivo para este día/turno.'), { status:422 });

      const estado = cerrar ? 'cerrado' : 'borrador';
      let cierreId;

      if (existente?.estado === 'borrador') {
        await conn.execute(
          `UPDATE caja_cierres SET monto_inicial=?,sistema_efectivo=?,sistema_tarjeta=?,
           sistema_transferencia=?,sistema_yape=?,sistema_plin=?,sistema_total=?,
           total_gastos=?,conteo_fisico=?,diferencia=?,estado=?,observaciones=? WHERE id=?`,
          [monto_inicial, totales.efectivo, totales.tarjeta, totales.transferencia,
           totales.yape, totales.plin, totales.total, totalGastos, conteo_fisico,
           diferencia, estado, observaciones||null, existente.id]
        );
        cierreId = existente.id;
        await conn.execute('DELETE FROM caja_gastos WHERE cierre_id=?', [existente.id]);
      } else {
        const [ins] = await conn.execute(
          `INSERT INTO caja_cierres
             (fecha,turno,realizado_por_id,monto_inicial,sistema_efectivo,sistema_tarjeta,
              sistema_transferencia,sistema_yape,sistema_plin,sistema_total,
              total_gastos,conteo_fisico,diferencia,estado,observaciones)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [fecha, turno, req.user.id, monto_inicial, totales.efectivo, totales.tarjeta,
           totales.transferencia, totales.yape, totales.plin, totales.total,
           totalGastos, conteo_fisico, diferencia, estado, observaciones||null]
        );
        cierreId = ins.insertId;
      }

      for (const g of gastos) {
        if (!g.descripcion?.trim() || !g.monto) continue;
        await conn.execute(
          'INSERT INTO caja_gastos (cierre_id, descripcion, monto, categoria) VALUES (?,?,?,?)',
          [cierreId, g.descripcion.trim(), parseFloat(g.monto), g.categoria||'otro']
        );
      }
      return { id:cierreId, diferencia, estado };
    });

    return res.json({
      success: true,
      message: cerrar ? '✅ Caja cerrada correctamente.' : '💾 Borrador guardado.',
      data: result,
    });
  } catch (err) { next(err); }
});

// PATCH /api/v1/caja/cierres/:id/cerrar
router.patch('/cierres/:id/cerrar', authorize('admin'), async (req, res, next) => {
  try {
    const [c] = await req.db.query('SELECT id, estado FROM caja_cierres WHERE id=?', [req.params.id]);
    if (!c) return res.status(404).json({ success:false, message:'No encontrado.' });
    if (c.estado==='cerrado') return res.status(422).json({ success:false, message:'Ya está cerrado.' });
    await req.db.query("UPDATE caja_cierres SET estado='cerrado' WHERE id=?", [req.params.id]);
    return res.json({ success:true, message:'Caja cerrada definitivamente.' });
  } catch (err) { next(err); }
});

module.exports = router;