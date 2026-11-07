'use strict';

/**
 * Gastos diarios — /api/v1/gastos
 *
 * Cada gasto tiene tipo (categoría), descripción, monto y método de pago.
 * Entra al cierre de caja de su fecha/sede: los de efectivo se descuentan del efectivo
 * esperado y los demás se muestran contra su método (tarjeta, Yape, Plin, transferencia).
 * No se eliminan: se anulan con motivo (queda auditoría). Un gasto que pertenece a un
 * cierre ya cerrado no se puede editar ni anular.
 */

const { Router } = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');
const {
  METODOS_PAGO, SELECT_GASTO, hoyTenant, sedeEscritura, sedeLectura, cajaCerradaDelDia,
} = require('../services/gastos.service');

const router = Router();
router.use(authenticate);
router.use(authorize('admin', 'recepcionista', 'veterinario_recepcionista'));

const FECHA_RE  = /^\d{4}-\d{2}-\d{2}$/;
const MONTO_MAX = 999999.99;
const COLOR_RE  = /^#[0-9a-f]{6}$/i;

const err422 = msg => Object.assign(new Error(msg), { status: 422 });
const limpiar = (v, max) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

function notificar(req, payload) {
  const io = req.app.get('io');
  if (io) io.emit('gasto:actualizado', { type: 'gasto:actualizado', payload });
}

/** Valida y normaliza el cuerpo de un gasto. Lanza 422 si algo no cuadra. */
async function validarGasto(req, body) {
  const fecha       = String(body.fecha || '').slice(0, 10);
  const descripcion = limpiar(body.descripcion, 255);
  const monto       = Math.round(parseFloat(body.monto) * 100) / 100;
  const metodo      = String(body.metodo_pago || 'efectivo');
  const categoriaId = parseInt(body.categoria_id, 10);

  if (!FECHA_RE.test(fecha))               throw err422('Fecha inválida.');
  if (fecha > hoyTenant(req))              throw err422('No se pueden registrar gastos con fecha futura.');
  if (!categoriaId)                        throw err422('Selecciona el tipo de gasto.');
  if (!descripcion)                        throw err422('La descripción es obligatoria.');
  if (!(monto > 0))                        throw err422('El monto debe ser mayor a cero.');
  if (monto > MONTO_MAX)                   throw err422('El monto es demasiado alto.');
  if (!METODOS_PAGO.includes(metodo))      throw err422('Método de pago inválido.');

  const [cat] = await req.db.query('SELECT id, activo FROM gastos_categorias WHERE id = ?', [categoriaId]);
  if (!cat)         throw err422('El tipo de gasto no existe.');
  if (!cat.activo)  throw err422('Ese tipo de gasto está desactivado.');

  return {
    fecha, descripcion, monto, metodo_pago: metodo, categoria_id: categoriaId,
    proveedor  : limpiar(body.proveedor, 120),
    comprobante: limpiar(body.comprobante, 60),
  };
}

async function obtenerGasto(req, id) {
  const [g] = await req.db.query(`${SELECT_GASTO} WHERE g.id = ?`, [id]);
  return g || null;
}

/** Un gasto anulado o de un cierre cerrado ya no se toca */
function bloqueoEdicion(g) {
  if (g.anulado) return 'Este gasto está anulado.';
  if (g.cierre_estado === 'cerrado')
    return 'Este gasto ya forma parte de un cierre de caja cerrado; no se puede modificar.';
  return null;
}

// ═════════════════════════════════════════════════════════════════
//  TIPOS DE GASTO (categorías)
// ═════════════════════════════════════════════════════════════════

// GET /api/v1/gastos/categorias?todas=1
router.get('/categorias', async (req, res, next) => {
  try {
    const todas = req.query.todas === '1';
    const rows = await req.db.query(
      `SELECT id, nombre, icono, color, orden, activo FROM gastos_categorias
       ${todas ? '' : 'WHERE activo = 1'} ORDER BY orden ASC, nombre ASC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/v1/gastos/categorias
router.post('/categorias', authorize('admin'), auditMiddleware('gastos:categoria_creada', 'gastos_categorias'), async (req, res, next) => {
  try {
    const nombre = limpiar(req.body.nombre, 60);
    if (!nombre) return res.status(422).json({ success: false, message: 'El nombre es obligatorio.' });
    const icono = limpiar(req.body.icono, 16) || '📌';
    const color = COLOR_RE.test(req.body.color || '') ? req.body.color : '#64748b';

    const [dup] = await req.db.query('SELECT id FROM gastos_categorias WHERE nombre = ?', [nombre]);
    if (dup) return res.status(422).json({ success: false, message: 'Ya existe un tipo de gasto con ese nombre.' });

    const [{ maxOrden }] = await req.db.query('SELECT COALESCE(MAX(orden),0) AS maxOrden FROM gastos_categorias WHERE orden < 99');
    const r = await req.db.query(
      'INSERT INTO gastos_categorias (nombre, icono, color, orden) VALUES (?,?,?,?)',
      [nombre, icono, color, maxOrden + 1]
    );
    return res.status(201).json({ success: true, message: 'Tipo de gasto creado.', data: { id: r.insertId } });
  } catch (err) { next(err); }
});

// PUT /api/v1/gastos/categorias/:id
router.put('/categorias/:id', authorize('admin'), auditMiddleware('gastos:categoria_actualizada', 'gastos_categorias'), async (req, res, next) => {
  try {
    const [cat] = await req.db.query('SELECT * FROM gastos_categorias WHERE id = ?', [req.params.id]);
    if (!cat) return res.status(404).json({ success: false, message: 'Tipo de gasto no encontrado.' });

    const nombre = req.body.nombre !== undefined ? limpiar(req.body.nombre, 60) : cat.nombre;
    if (!nombre) return res.status(422).json({ success: false, message: 'El nombre es obligatorio.' });
    const icono  = req.body.icono  !== undefined ? (limpiar(req.body.icono, 16) || '📌') : cat.icono;
    const color  = COLOR_RE.test(req.body.color || '') ? req.body.color : cat.color;
    const activo = req.body.activo !== undefined ? (req.body.activo ? 1 : 0) : cat.activo;

    const [dup] = await req.db.query('SELECT id FROM gastos_categorias WHERE nombre = ? AND id <> ?', [nombre, cat.id]);
    if (dup) return res.status(422).json({ success: false, message: 'Ya existe un tipo de gasto con ese nombre.' });

    await req.db.query(
      'UPDATE gastos_categorias SET nombre=?, icono=?, color=?, activo=? WHERE id=?',
      [nombre, icono, color, activo, cat.id]
    );
    return res.json({ success: true, message: 'Tipo de gasto actualizado.' });
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════════════
//  GASTOS
// ═════════════════════════════════════════════════════════════════

// GET /api/v1/gastos?desde&hasta&categoria_id&metodo_pago&estado=activos|anulados|todos&q
router.get('/', async (req, res, next) => {
  try {
    const hoy   = hoyTenant(req);
    let desde   = FECHA_RE.test(req.query.desde || '') ? req.query.desde : hoy;
    let hasta   = FECHA_RE.test(req.query.hasta || '') ? req.query.hasta : desde;
    if (desde > hasta) [desde, hasta] = [hasta, desde];
    const sedeId = sedeLectura(req);
    const estado = ['activos', 'anulados', 'todos'].includes(req.query.estado) ? req.query.estado : 'activos';

    let where = 'WHERE g.fecha BETWEEN ? AND ?';
    const params = [desde, hasta];
    if (sedeId)                 { where += ' AND g.sede_id = ?';      params.push(sedeId); }
    if (req.query.categoria_id) { where += ' AND g.categoria_id = ?'; params.push(parseInt(req.query.categoria_id, 10) || 0); }
    if (METODOS_PAGO.includes(req.query.metodo_pago)) { where += ' AND g.metodo_pago = ?'; params.push(req.query.metodo_pago); }
    if (estado === 'activos')  where += ' AND g.anulado = 0';
    if (estado === 'anulados') where += ' AND g.anulado = 1';
    const q = limpiar(req.query.q, 80);
    if (q) {
      where += ' AND (g.descripcion LIKE ? OR g.proveedor LIKE ? OR g.comprobante LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const rows = await req.db.query(
      `${SELECT_GASTO} ${where} ORDER BY g.fecha DESC, g.created_at DESC LIMIT 1000`, params
    );

    // Resumen del filtro (solo gastos vigentes)
    const vigentes = rows.filter(g => !g.anulado);
    const total    = +vigentes.reduce((a, g) => a + parseFloat(g.monto), 0).toFixed(2);
    const porCat   = {};
    const porMet   = Object.fromEntries(METODOS_PAGO.map(m => [m, 0]));
    for (const g of vigentes) {
      const k = g.categoria_id;
      porCat[k] = porCat[k] || { categoria_id: k, nombre: g.categoria_nombre, icono: g.categoria_icono, color: g.categoria_color, total: 0, cantidad: 0 };
      porCat[k].total += parseFloat(g.monto);
      porCat[k].cantidad++;
      porMet[g.metodo_pago] += parseFloat(g.monto);
    }
    const por_categoria = Object.values(porCat)
      .map(c => ({ ...c, total: +c.total.toFixed(2), pct: total ? +((c.total / total) * 100).toFixed(1) : 0 }))
      .sort((a, b) => b.total - a.total);
    for (const m of METODOS_PAGO) porMet[m] = +porMet[m].toFixed(2);

    return res.json({
      success: true,
      data: rows,
      resumen: { desde, hasta, total, cantidad: vigentes.length, anulados: rows.length - vigentes.length, por_categoria, por_metodo: porMet },
    });
  } catch (err) { next(err); }
});

// GET /api/v1/gastos/:id
router.get('/:id', async (req, res, next) => {
  try {
    const g = await obtenerGasto(req, req.params.id);
    if (!g) return res.status(404).json({ success: false, message: 'Gasto no encontrado.' });
    return res.json({ success: true, data: g });
  } catch (err) { next(err); }
});

// POST /api/v1/gastos
router.post('/', auditMiddleware('gastos:creado', 'gastos'), async (req, res, next) => {
  try {
    const d      = await validarGasto(req, req.body);
    const sedeId = sedeEscritura(req);

    if (await cajaCerradaDelDia(req.db.query, { fecha: d.fecha, sedeId }))
      return res.status(422).json({ success: false, message: `La caja del ${d.fecha.split('-').reverse().join('/')} ya está cerrada. No se pueden agregar gastos a ese día.` });

    const r = await req.db.query(
      `INSERT INTO gastos (fecha, sede_id, categoria_id, descripcion, monto, metodo_pago,
                           proveedor, comprobante, registrado_por_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [d.fecha, sedeId, d.categoria_id, d.descripcion, d.monto, d.metodo_pago,
       d.proveedor, d.comprobante, req.user.id]
    );
    notificar(req, { id: r.insertId, fecha: d.fecha, sede_id: sedeId });
    return res.status(201).json({ success: true, message: 'Gasto registrado.', data: { id: r.insertId } });
  } catch (err) { next(err); }
});

// PUT /api/v1/gastos/:id
router.put('/:id', auditMiddleware('gastos:actualizado', 'gastos'), async (req, res, next) => {
  try {
    const g = await obtenerGasto(req, req.params.id);
    if (!g) return res.status(404).json({ success: false, message: 'Gasto no encontrado.' });
    const bloqueo = bloqueoEdicion(g);
    if (bloqueo) return res.status(422).json({ success: false, message: bloqueo });

    const d = await validarGasto(req, req.body);
    if (d.fecha !== g.fecha && await cajaCerradaDelDia(req.db.query, { fecha: d.fecha, sedeId: g.sede_id }))
      return res.status(422).json({ success: false, message: 'La caja de la nueva fecha ya está cerrada.' });

    // Si estaba en un borrador de cierre se desliga: el próximo guardado del cierre lo vuelve a tomar
    await req.db.query(
      `UPDATE gastos SET fecha=?, categoria_id=?, descripcion=?, monto=?, metodo_pago=?,
              proveedor=?, comprobante=?, cierre_id=NULL
       WHERE id=?`,
      [d.fecha, d.categoria_id, d.descripcion, d.monto, d.metodo_pago, d.proveedor, d.comprobante, g.id]
    );
    notificar(req, { id: g.id, fecha: d.fecha, sede_id: g.sede_id });
    return res.json({ success: true, message: 'Gasto actualizado.' });
  } catch (err) { next(err); }
});

// PATCH /api/v1/gastos/:id/anular  { motivo }
router.patch('/:id/anular', auditMiddleware('gastos:anulado', 'gastos'), async (req, res, next) => {
  try {
    const g = await obtenerGasto(req, req.params.id);
    if (!g) return res.status(404).json({ success: false, message: 'Gasto no encontrado.' });
    const bloqueo = bloqueoEdicion(g);
    if (bloqueo) return res.status(422).json({ success: false, message: bloqueo });

    const motivo = limpiar(req.body.motivo, 200);
    if (!motivo) return res.status(422).json({ success: false, message: 'Indica el motivo de la anulación.' });

    await req.db.query(
      `UPDATE gastos SET anulado=1, anulado_por_id=?, anulado_motivo=?, anulado_at=NOW(), cierre_id=NULL
       WHERE id=?`,
      [req.user.id, motivo, g.id]
    );
    notificar(req, { id: g.id, fecha: g.fecha, sede_id: g.sede_id });
    return res.json({ success: true, message: 'Gasto anulado.' });
  } catch (err) { next(err); }
});

module.exports = router;
