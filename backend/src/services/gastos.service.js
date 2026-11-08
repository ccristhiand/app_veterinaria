'use strict';

/**
 * Lógica compartida de Gastos diarios entre /gastos y /caja.
 *
 * Un gasto entra al cierre de caja de su fecha y sede. Al guardar el cierre (borrador o
 * definitivo) los gastos quedan ligados con cierre_id; cuando el cierre está 'cerrado'
 * ya no se pueden editar ni anular.
 *
 * Las funciones reciben `q(sql, params) → rows` para poder usarse con req.db.query
 * o con una conexión de transacción (ver qConn).
 */

const METODOS_PAGO = ['efectivo', 'tarjeta', 'transferencia', 'yape', 'plin'];

/** Adapta conn.execute (devuelve [rows, fields]) a la firma q(sql, params) → rows */
const qConn = conn => async (sql, params) => (await conn.execute(sql, params))[0];

/** Fecha de hoy (YYYY-MM-DD) en la zona horaria de la clínica */
function hoyTenant(req) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: req.tenant?.zona_horaria || 'America/Lima',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

const SELECT_GASTO = `
  SELECT g.*, DATE_FORMAT(g.fecha, '%Y-%m-%d') AS fecha,
         gc.nombre AS categoria_nombre, gc.icono AS categoria_icono, gc.color AS categoria_color,
         u.nombre AS registrado_por, s.nombre AS sede_nombre,
         cc.estado AS cierre_estado
  FROM gastos g
  JOIN gastos_categorias gc ON gc.id = g.categoria_id
  JOIN usuarios u           ON u.id  = g.registrado_por_id
  LEFT JOIN sedes s         ON s.id  = g.sede_id
  LEFT JOIN caja_cierres cc ON cc.id = g.cierre_id`;

/**
 * Gastos que corresponden a un cierre: del día y la sede, no anulados,
 * todavía sin cierre o ya ligados a este mismo cierre.
 */
async function gastosParaCierre(q, { fecha, filtro, cierreId }) {
  return q(
    `${SELECT_GASTO}
     WHERE g.fecha = ? AND g.anulado = 0 AND (g.cierre_id IS NULL OR g.cierre_id = ?) ${filtro.sql}
     ORDER BY g.created_at ASC`,
    [fecha, cierreId || 0, ...filtro.params]
  );
}

/** Configuración de la clínica: ¿los gastos se descuentan en el cierre de caja? */
async function gastosAfectanCaja(q) {
  try {
    const [cfg] = await q('SELECT gastos_afectan_caja FROM empresa_config LIMIT 1');
    return cfg ? !!cfg.gastos_afectan_caja : true;
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') return true;   // clínica aún sin migración v22
    throw e;
  }
}

/** { efectivo, tarjeta, transferencia, yape, plin, total } con 2 decimales */
function totalesPorMetodo(gastos) {
  const t = Object.fromEntries(METODOS_PAGO.map(m => [m, 0]));
  for (const g of gastos) {
    const m = METODOS_PAGO.includes(g.metodo_pago) ? g.metodo_pago : 'efectivo';
    t[m] += parseFloat(g.monto) || 0;
  }
  for (const m of METODOS_PAGO) t[m] = +t[m].toFixed(2);
  t.total = +METODOS_PAGO.reduce((a, m) => a + t[m], 0).toFixed(2);
  return t;
}

/** ¿La caja de ese día/sede ya se cerró por completo? (día completo, o mañana + tarde) */
async function cajaCerradaDelDia(q, { fecha, sedeId }) {
  const turnos = (await q(
    "SELECT DISTINCT turno FROM caja_cierres WHERE fecha = ? AND estado = 'cerrado' AND sede_id = ?",
    [fecha, sedeId]
  )).map(r => r.turno);
  return turnos.includes('dia_completo') || (turnos.includes('mañana') && turnos.includes('tarde'));
}

module.exports = {
  METODOS_PAGO, SELECT_GASTO, qConn, hoyTenant,
  gastosParaCierre, gastosAfectanCaja, totalesPorMetodo, cajaCerradaDelDia,
};
