'use strict';

/**
 * Pagos de comprobantes (factura_pagos): adelantos y abonos.
 *
 * Un comprobante puede cobrarse en varias partes. Queda 'pendiente' mientras el saldo
 * (total − pagado) sea mayor a 0 y pasa a 'pagado' cuando se completa.
 *
 * Cada pago entra a la caja del día en que se cobró:
 *  · los pagos registrados al emitir → fecha del comprobante (f.fecha)
 *  · los abonos posteriores          → fecha local de fp.created_at
 *
 * Se usa UNIX_TIMESTAMP para no depender de la zona horaria de la sesión de MySQL.
 */

const TOLERANCIA = 0.01;

/** Offset en segundos de la zona horaria de la clínica (Lima → -18000) */
function offsetSegundos(req) {
  try {
    const parte = new Intl.DateTimeFormat('en-US', {
      timeZone: req.tenant?.zona_horaria || 'America/Lima',
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || 'GMT-5';
    const m = parte.match(/GMT([+-])(\d+)(?::(\d+))?/);
    if (!m) return 0;
    const seg = parseInt(m[2], 10) * 3600 + parseInt(m[3] || '0', 10) * 60;
    return m[1] === '-' ? -seg : seg;
  } catch {
    return -5 * 3600;
  }
}

/** Expresión SQL: día (DATE) en que entró el pago `fp` del comprobante `f` */
function diaPagoSql(req) {
  const off = offsetSegundos(req) | 0;   // entero: se puede incrustar sin riesgo
  return `(CASE WHEN fp.created_at <= f.created_at + INTERVAL 10 MINUTE THEN f.fecha
               ELSE DATE('1970-01-01' + INTERVAL (UNIX_TIMESTAMP(fp.created_at) + (${off})) SECOND) END)`;
}

/** Subconsulta SQL: total pagado del comprobante `f` */
const PAGADO_SQL = '(SELECT COALESCE(SUM(fp2.monto),0) FROM factura_pagos fp2 WHERE fp2.factura_id = f.id)';

const redondear = n => Math.round((parseFloat(n) || 0) * 100) / 100;

module.exports = { TOLERANCIA, offsetSegundos, diaPagoSql, PAGADO_SQL, redondear };
