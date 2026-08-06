'use strict';

const { query, queryOne, generarNumeroCobro } = require('../db');
const emailService = require('./email.service');

// ── Generar cobros mensuales (día 1 de cada mes) ──────────────
async function generarCobrosMensuales() {
  const periodo  = new Date().toISOString().slice(0, 7); // '2026-08'
  const fechaEmision    = new Date().toISOString().split('T')[0];
  const fechaVencimiento = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 5)
    .toISOString().split('T')[0]; // día 5 del mes siguiente

  const suscripciones = await query(
    `SELECT ss.tenant_id, ss.id AS sus_id, ss.precio_acordado
     FROM saas_suscripciones ss
     WHERE ss.estado IN ('activa','vencida')
       AND NOT EXISTS (
         SELECT 1 FROM saas_cobros c
         WHERE c.tenant_id = ss.tenant_id AND c.periodo = ?
       )`,
    [periodo]
  );

  let generados = 0;
  for (const sus of suscripciones) {
    try {
      const numero = await generarNumeroCobro();
      await query(
        `INSERT INTO saas_cobros
           (tenant_id, suscripcion_id, periodo, meses, monto_base, descuento_pct,
            monto_final, estado, fecha_emision, fecha_vencimiento, numero_cobro)
         VALUES (?,?,?,1,?,0,?,\'pendiente\',?,?,?)`,
        [sus.tenant_id, sus.sus_id, periodo, sus.precio_acordado,
         sus.precio_acordado, fechaEmision, fechaVencimiento, numero]
      );
      generados++;

      // Notificar al cliente
      const cliente = await queryOne(
        `SELECT pu.email, pu.nombre, tc.nombre_clinica, sp.nombre AS plan_nombre
         FROM saas_portal_usuarios pu
         JOIN tenant_config tc ON tc.tenant_id = pu.tenant_id
         JOIN saas_suscripciones ss ON ss.tenant_id = pu.tenant_id
         JOIN saas_planes sp ON sp.id = ss.plan_id
         WHERE pu.tenant_id = ?`,
        [sus.tenant_id]
      );
      if (cliente) {
        await emailService.enviarRecordatorio({
          email            : cliente.email,
          nombre           : cliente.nombre,
          clinica_nombre   : cliente.nombre_clinica,
          fecha_vencimiento: fechaVencimiento,
          plan_nombre      : cliente.plan_nombre,
          monto            : sus.precio_acordado,
        });
      }
    } catch (e) {
      console.error(`[Cron] Error generando cobro tenant ${sus.tenant_id}:`, e.message);
    }
  }

  console.log(`[Cron] ✅ ${generados} cobros generados para ${periodo}`);
  return generados;
}

// ── Enviar recordatorios de vencimiento próximo ───────────────
async function enviarRecordatorios() {
  // 7 días antes
  const por7dias = await query(
    `SELECT ss.tenant_id, ss.fecha_vencimiento, ss.precio_acordado,
            pu.email, pu.nombre, tc.nombre_clinica, sp.nombre AS plan_nombre
     FROM saas_suscripciones ss
     JOIN saas_portal_usuarios pu ON pu.tenant_id = ss.tenant_id
     JOIN tenant_config tc ON tc.tenant_id = ss.tenant_id
     JOIN saas_planes sp ON sp.id = ss.plan_id
     WHERE ss.fecha_vencimiento = CURDATE() + INTERVAL 7 DAY
       AND ss.estado = 'activa'`
  );

  // 3 días antes
  const por3dias = await query(
    `SELECT ss.tenant_id, ss.fecha_vencimiento, ss.precio_acordado,
            pu.email, pu.nombre, tc.nombre_clinica, sp.nombre AS plan_nombre
     FROM saas_suscripciones ss
     JOIN saas_portal_usuarios pu ON pu.tenant_id = ss.tenant_id
     JOIN tenant_config tc ON tc.tenant_id = ss.tenant_id
     JOIN saas_planes sp ON sp.id = ss.plan_id
     WHERE ss.fecha_vencimiento = CURDATE() + INTERVAL 3 DAY
       AND ss.estado = 'activa'`
  );

  const todos = [...por7dias, ...por3dias];
  for (const c of todos) {
    try {
      await emailService.enviarRecordatorio({
        email            : c.email,
        nombre           : c.nombre,
        clinica_nombre   : c.nombre_clinica,
        fecha_vencimiento: c.fecha_vencimiento,
        plan_nombre      : c.plan_nombre,
        monto            : c.precio_acordado,
      });
    } catch (e) {
      console.error(`[Cron] Error recordatorio ${c.email}:`, e.message);
    }
  }
  console.log(`[Cron] ✅ ${todos.length} recordatorios enviados`);
}

// ── Suspender tenants vencidos ────────────────────────────────
async function suspenderVencidos() {
  const [cfg] = await query('SELECT valor FROM saas_config WHERE clave=\'dias_gracia\'');
  const diasGracia = parseInt(cfg?.valor) || 5;

  const vencidos = await query(
    `SELECT ss.tenant_id, tc.nombre_clinica, pu.email, pu.nombre
     FROM saas_suscripciones ss
     JOIN tenant_config tc ON tc.tenant_id = ss.tenant_id
     LEFT JOIN saas_portal_usuarios pu ON pu.tenant_id = ss.tenant_id
     WHERE ss.fecha_vencimiento < CURDATE() - INTERVAL ? DAY
       AND ss.estado = 'activa'
       AND NOT EXISTS (
         SELECT 1 FROM saas_pagos p
         JOIN saas_cobros c ON c.id = p.cobro_id
         WHERE c.tenant_id = ss.tenant_id
           AND p.estado IN ('pendiente_validacion','aprobado')
           AND p.created_at >= ss.fecha_vencimiento
       )`,
    [diasGracia]
  );

  for (const v of vencidos) {
    try {
      await query('UPDATE tenants SET activo=0 WHERE id=?', [v.tenant_id]);
      await query('UPDATE saas_suscripciones SET estado=\'vencida\' WHERE tenant_id=?', [v.tenant_id]);

      // Email de suspensión
      if (v.email) {
        const asunto = '❌ Acceso suspendido — Renueva tu suscripción';
        console.log(`[Cron] Suspendido: ${v.nombre_clinica} (${v.email})`);
      }
    } catch (e) {
      console.error(`[Cron] Error suspendiendo ${v.tenant_id}:`, e.message);
    }
  }
  if (vencidos.length) console.log(`[Cron] ⚠️ ${vencidos.length} tenants suspendidos`);
}

// ── Resumen diario al admin ───────────────────────────────────
async function resumenDiarioAdmin() {
  const [stats] = await query(
    `SELECT
       COUNT(CASE WHEN p.estado='pendiente_validacion' THEN 1 END) AS pendientes,
       COUNT(CASE WHEN ss.fecha_vencimiento = CURDATE() + INTERVAL 7 DAY THEN 1 END) AS vencen_7d,
       COUNT(CASE WHEN t.activo=0 AND ss.estado='vencida' THEN 1 END) AS suspendidos
     FROM saas_suscripciones ss
     JOIN tenants t ON t.id = ss.tenant_id
     LEFT JOIN saas_cobros c ON c.tenant_id = ss.tenant_id AND c.estado='pendiente'
     LEFT JOIN saas_pagos p ON p.cobro_id = c.id`
  );

  if (stats?.pendientes > 0 || stats?.vencen_7d > 0) {
    console.log(`[Cron] Resumen: ${stats.pendientes} pendientes, ${stats.vencen_7d} vencen en 7d, ${stats.suspendidos} suspendidos`);
  }
}

// ── Iniciar todos los crons ───────────────────────────────────
function iniciar() {
  const ahora = new Date();

  // Día 1 del mes a las 8am
  function msHastaDia1() {
    const prox = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 1, 8, 0, 0);
    return prox - ahora;
  }
  setTimeout(() => {
    generarCobrosMensuales();
    setInterval(generarCobrosMensuales, 30 * 24 * 60 * 60 * 1000); // cada 30 días
  }, msHastaDia1());

  // Recordatorios diarios a las 9am
  function msHastaHora(h, m = 0) {
    const prox = new Date(ahora);
    prox.setHours(h, m, 0, 0);
    if (prox <= ahora) prox.setDate(prox.getDate() + 1);
    return prox - ahora;
  }
  setTimeout(() => {
    enviarRecordatorios();
    setInterval(enviarRecordatorios, 24 * 60 * 60 * 1000);
  }, msHastaHora(9));

  // Suspensión diaria a las 10am
  setTimeout(() => {
    suspenderVencidos();
    setInterval(suspenderVencidos, 24 * 60 * 60 * 1000);
  }, msHastaHora(10));

  // Resumen diario al admin a las 8am
  setTimeout(() => {
    resumenDiarioAdmin();
    setInterval(resumenDiarioAdmin, 24 * 60 * 60 * 1000);
  }, msHastaHora(8));

  console.log('[Cron] ✅ Todos los crons programados');
}

module.exports = { iniciar, generarCobrosMensuales, enviarRecordatorios, suspenderVencidos };