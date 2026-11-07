'use strict';

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');
const { qConn, gastosParaCierre, totalesPorMetodo } = require('../services/gastos.service');

const router = Router();
router.use(authenticate);
router.use(authorize('admin', 'recepcionista'));

// ── Helper: filtro de sede ────────────────────────────────────────
function getSedeFiltro(req) {
  const user   = req.user;
  const header = req.headers['x-sede-id'] ? parseInt(req.headers['x-sede-id']) : null;
  if (user.rol === 'admin') return header || null;
  return user.sede_id || header || null;
}

function sedeSQL(sedeId, col) {
  col = col || 'sede_id';
  if (!sedeId) return { sql: '', params: [] };
  return { sql: 'AND ' + col + ' = ?', params: [sedeId] };
}

// Gastos vigentes ligados a cada cierre → { cierreId: [gastos] }
async function gastosDeCierres(req, ids) {
  if (!ids.length) return {};
  const rows = await req.db.query(
    `SELECT g.id, g.cierre_id, g.descripcion, g.monto, g.metodo_pago, g.proveedor, g.comprobante,
            gc.nombre AS categoria_nombre, gc.icono AS categoria_icono
     FROM gastos g JOIN gastos_categorias gc ON gc.id = g.categoria_id
     WHERE g.anulado = 0 AND g.cierre_id IN (${ids.map(() => '?').join(',')})
     ORDER BY g.created_at ASC`,
    ids
  );
  const map = {};
  for (const g of rows) (map[g.cierre_id] = map[g.cierre_id] || []).push(g);
  return map;
}

// GET /api/v1/caja/resumen-dia
router.get('/resumen-dia', async (req, res, next) => {
  try {
    const { fecha, turno } = req.query;
    const dia    = fecha || new Date().toISOString().split('T')[0];
    const sedeId = getSedeFiltro(req);
    const { sql: sff, params: spf } = sedeSQL(sedeId, 'f.sede_id');
    const { sql: sf,  params: sp  } = sedeSQL(sedeId, 'sede_id');

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
       WHERE f.fecha = ? AND f.estado = 'pagado' ${sff}`,
      [dia, ...spf]
    );

    const [cierreExistente] = await req.db.query(
      `SELECT id, estado, conteo_fisico, diferencia, total_gastos, gastos_efectivo, monto_inicial, observaciones
       FROM caja_cierres
       WHERE fecha = ? AND turno = ? ${sedeId ? 'AND sede_id = ?' : ''}
       ORDER BY created_at DESC LIMIT 1`,
      [dia, turno || 'dia_completo', ...(sedeId ? [sedeId] : [])]
    );

    const [pendientes] = await req.db.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(total),0) AS monto
       FROM facturas WHERE fecha = ? AND estado = 'pendiente' ${sf}`,
      [dia, ...sp]
    );

    // Gastos del módulo Gastos diarios que entran a este cierre
    let gastos;
    if (cierreExistente?.estado === 'cerrado') {
      gastos = await req.db.query(
        `SELECT g.*, gc.nombre AS categoria_nombre, gc.icono AS categoria_icono
         FROM gastos g JOIN gastos_categorias gc ON gc.id = g.categoria_id
         WHERE g.cierre_id = ? AND g.anulado = 0 ORDER BY g.created_at ASC`,
        [cierreExistente.id]
      );
    } else {
      gastos = await gastosParaCierre(req.db.query, { fecha: dia, sedeId, cierreId: cierreExistente?.id });
    }

    return res.json({
      success: true,
      data: { fecha: dia, turno: turno || 'dia_completo', totales, pendientes,
              cierre_existente: cierreExistente || null, gastos, gastos_totales: totalesPorMetodo(gastos) },
    });
  } catch (err) { next(err); }
});

// GET /api/v1/caja/cierres
router.get('/cierres', async (req, res, next) => {
  try {
    const { desde, hasta, page = 1 } = req.query;
    const limit   = 20;
    const offset  = (parseInt(page) - 1) * limit;
    const sedeId  = getSedeFiltro(req);

    let sql = `SELECT cc.*, u.nombre AS realizado_por, s.nombre AS sede_nombre
               FROM caja_cierres cc
               JOIN usuarios u ON u.id = cc.realizado_por_id
               LEFT JOIN sedes s ON s.id = cc.sede_id
               WHERE 1=1`;
    const params = [];

    if (sedeId) { sql += ' AND cc.sede_id = ?'; params.push(sedeId); }
    if (desde)  { sql += ' AND cc.fecha >= ?';  params.push(desde); }
    if (hasta)  { sql += ' AND cc.fecha <= ?';  params.push(hasta); }

    sql += ` ORDER BY cc.fecha DESC, cc.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    const rows = await req.db.query(sql, params);
    const gastosPorCierre = await gastosDeCierres(req, rows.map(r => r.id));
    for (const row of rows) row.gastos = gastosPorCierre[row.id] || [];
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/v1/caja/cierres/:id
router.get('/cierres/:id', async (req, res, next) => {
  try {
    const [cierre] = await req.db.query(
      `SELECT cc.*, u.nombre AS realizado_por, s.nombre AS sede_nombre
       FROM caja_cierres cc
       JOIN usuarios u ON u.id = cc.realizado_por_id
       LEFT JOIN sedes s ON s.id = cc.sede_id
       WHERE cc.id = ?`, [req.params.id]
    );
    if (!cierre) return res.status(404).json({ success: false, message: 'No encontrado.' });
    cierre.gastos = (await gastosDeCierres(req, [cierre.id]))[cierre.id] || [];
    return res.json({ success: true, data: cierre });
  } catch (err) { next(err); }
});

// POST /api/v1/caja/cierres
router.post('/cierres', auditMiddleware('caja:creado', 'caja'), async (req, res, next) => {
  try {
    // Los gastos ya no vienen en el body: se toman del módulo Gastos diarios
    const { fecha, turno = 'dia_completo', monto_inicial = 0, conteo_fisico, observaciones, cerrar = false } = req.body;
    if (!fecha) return res.status(422).json({ success: false, message: 'fecha requerida.' });
    if (conteo_fisico === undefined || conteo_fisico === null)
      return res.status(422).json({ success: false, message: 'conteo_fisico requerido.' });

    // Sede del usuario que cierra caja
    const sedeId = req.user.sede_id ||
                   (req.headers['x-sede-id'] ? parseInt(req.headers['x-sede-id']) : null);
    const { sql: sff, params: spf } = sedeSQL(sedeId, 'f.sede_id');
    const sp = sedeId ? [sedeId] : [];

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
       WHERE f.fecha = ? AND f.estado = 'pagado' ${sff}`,
      [fecha, ...spf]
    );

    const result = await req.db.withTransaction(async (conn) => {
      const [[existente]] = await conn.execute(
        `SELECT id, estado FROM caja_cierres
         WHERE fecha=? AND turno=? ${sedeId ? 'AND sede_id=?' : ''}
         ORDER BY created_at DESC LIMIT 1`,
        [fecha, turno, ...sp]
      );
      if (existente?.estado === 'cerrado')
        throw Object.assign(new Error('Ya existe un cierre definitivo para este día/turno.'), { status: 422 });

      // Gastos del día/sede que entran a este cierre, desglosados por método de pago.
      // Solo el efectivo sale de la caja física; el resto se descuenta de su propio método.
      const gastos = await gastosParaCierre(qConn(conn), { fecha, sedeId, cierreId: existente?.id });
      const gt     = totalesPorMetodo(gastos);
      const efectivoEsperado = parseFloat(monto_inicial) + parseFloat(totales.efectivo) - gt.efectivo;
      const diferencia       = parseFloat((parseFloat(conteo_fisico) - efectivoEsperado).toFixed(2));

      const estado = cerrar ? 'cerrado' : 'borrador';
      let cierreId;

      if (existente?.estado === 'borrador') {
        await conn.execute(
          `UPDATE caja_cierres SET monto_inicial=?,sistema_efectivo=?,sistema_tarjeta=?,
           sistema_transferencia=?,sistema_yape=?,sistema_plin=?,sistema_total=?,
           total_gastos=?,gastos_efectivo=?,gastos_tarjeta=?,gastos_transferencia=?,gastos_yape=?,gastos_plin=?,
           conteo_fisico=?,diferencia=?,estado=?,observaciones=? WHERE id=?`,
          [monto_inicial, totales.efectivo, totales.tarjeta, totales.transferencia,
           totales.yape, totales.plin, totales.total,
           gt.total, gt.efectivo, gt.tarjeta, gt.transferencia, gt.yape, gt.plin,
           conteo_fisico, diferencia, estado, observaciones || null, existente.id]
        );
        cierreId = existente.id;
      } else {
        const [ins] = await conn.execute(
          `INSERT INTO caja_cierres
             (fecha, turno, realizado_por_id, sede_id, monto_inicial,
              sistema_efectivo, sistema_tarjeta, sistema_transferencia,
              sistema_yape, sistema_plin, sistema_total,
              total_gastos, gastos_efectivo, gastos_tarjeta, gastos_transferencia, gastos_yape, gastos_plin,
              conteo_fisico, diferencia, estado, observaciones)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [fecha, turno, req.user.id, sedeId,
           monto_inicial, totales.efectivo, totales.tarjeta, totales.transferencia,
           totales.yape, totales.plin, totales.total,
           gt.total, gt.efectivo, gt.tarjeta, gt.transferencia, gt.yape, gt.plin,
           conteo_fisico, diferencia, estado, observaciones || null]
        );
        cierreId = ins.insertId;
      }

      // Ligar los gastos a este cierre (al cerrarlo quedan bloqueados para edición)
      if (gastos.length) {
        const ids = gastos.map(g => g.id);
        await conn.execute(
          `UPDATE gastos SET cierre_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
          [cierreId, ...ids]
        );
      }
      return { id: cierreId, diferencia, estado, gastos: gt };
    });

    return res.json({
      success: true,
      message: cerrar ? '✅ Caja cerrada correctamente.' : '💾 Borrador guardado.',
      data: result,
    });
  } catch (err) { next(err); }
});

// PATCH /api/v1/caja/cierres/:id/cerrar
router.patch('/cierres/:id/cerrar', authorize('admin'), auditMiddleware('caja:actualizado', 'caja'), async (req, res, next) => {
  try {
    const [c] = await req.db.query('SELECT id, estado FROM caja_cierres WHERE id=?', [req.params.id]);
    if (!c) return res.status(404).json({ success: false, message: 'No encontrado.' });
    if (c.estado === 'cerrado') return res.status(422).json({ success: false, message: 'Ya está cerrado.' });
    await req.db.query("UPDATE caja_cierres SET estado='cerrado' WHERE id=?", [req.params.id]);
    return res.json({ success: true, message: 'Caja cerrada definitivamente.' });
  } catch (err) { next(err); }
});

module.exports = router;