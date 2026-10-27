'use strict';

/**
 * VetNetcodip — Recordatorios por WhatsApp Meta (API oficial)
 * Revisa cada 30 minutos citas, vacunas y desparasitaciones pendientes de las clínicas
 * que envían por Meta y las manda con la plantilla aprobada de cada recordatorio
 * (wa_meta_plantillas, es_estandar = 1). Sin plantilla aprobada, ese recordatorio no se envía.
 *
 * Independiente de wa-gateway (QR / Baileys): ese proceso atiende solo a las clínicas por QR.
 * La configuración (horas, días, activo) es la misma tabla wa_config de la clínica.
 */

const { masterQuery, getTenantConn, SQL_TENANTS_META, enviarPlantilla, fDate, fHora, esperar } = require('./cron-comun');

// Plantillas aprobadas de la clínica, por uso (se lee una vez por ciclo)
async function plantillasAprobadas(conn) {
  try {
    const [rows] = await conn.execute(
      `SELECT uso, nombre_meta, idioma, cuerpo, variables FROM wa_meta_plantillas
       WHERE es_estandar = 1 AND activo = 1 AND estado = 'aprobada' ORDER BY id DESC`
    );
    const m = {};
    for (const r of rows) {
      if (m[r.uso]) continue;
      let vars = [];
      try { vars = JSON.parse(r.variables || '[]'); } catch { vars = []; }
      m[r.uso] = { nombre: r.nombre_meta, idioma: r.idioma || 'es', cuerpo: r.cuerpo, variables: vars };
    }
    return m;
  } catch { return {}; }   // clínica sin migración v18
}

/**
 * Envía un recordatorio con la primera plantilla aprobada de `usos`.
 * Devuelve 'enviado', 'fallido' (Meta lo rechazó de forma definitiva: no se reintenta)
 * u 'omitido' (sin plantilla aprobada: se reintentará cuando la aprueben).
 * Lanza error si conviene reintentar en el próximo ciclo.
 */
async function enviarRecordatorio(tenant, cfg, { usos, datos, telefono, tipoLog, propietarioId }) {
  const p = usos.map(u => tenant.plantillas[u]).find(Boolean);
  if (!p) {
    const clave = usos[0];
    if (!tenant._avisados.has(clave)) {
      tenant._avisados.add(clave);
      console.log(`[Meta Recordatorios] ⚠️ ${tenant.slug}: sin plantilla aprobada para "${clave}" — no se envía (apruébala en WhatsApp Meta → Recordatorios)`);
    }
    return 'omitido';
  }
  const variables = p.variables.map(k => datos[k] || '-');
  const resumen   = p.cuerpo.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => variables[n - 1] || '');
  const r = await enviarPlantilla({
    tenantId: tenant.id, telefono, plantilla: p.nombre, idioma: p.idioma, variables,
    tipo: tipoLog, propietarioId: propietarioId || null, resumen, codigoPais: cfg.codigo_pais || '+51',
  });
  if (r.success) return 'enviado';
  if (r.reintentar === false) {
    console.error(`[Meta Recordatorios] ❌ ${tenant.slug} → ${telefono}: ${r.message}`);
    return 'fallido';
  }
  throw new Error(r.message || 'Meta no envió el mensaje');
}

// Mapa tipo_cita → uso de la plantilla
const TIPO_CITA_USO = {
  medica          : 'recordatorio_cita',
  vacuna          : 'recordatorio_cita_vacuna',
  desparasitacion : 'recordatorio_cita_desparasitacion',
  estetica        : 'recordatorio_cita_estetica',
};

const NOMBRE_PROPIETARIO = `COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.nombre, p.apellido)),''), p.razon_social)`;

// ── Recordatorios de CITAS ────────────────────────────────────
async function procesarCitas(tenant, conn, cfg) {
  const rangos = [cfg.recordatorio_citas_horas || 24];
  if (cfg.recordatorio_citas_horas2) rangos.push(cfg.recordatorio_citas_horas2);
  const tz = tenant.zona_horaria || 'America/Lima';

  for (const horas of rangos) {
    const [citas] = await conn.execute(
      `SELECT c.id, c.fecha_hora, c.tipo_cita, p.id AS propietario_id,
              m.nombre AS mascota, ${NOMBRE_PROPIETARIO} AS propietario, p.telefono
       FROM citas c
       JOIN mascotas m ON m.id = c.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       WHERE c.estado IN ('pendiente','confirmada')
         AND p.telefono IS NOT NULL
         AND c.fecha_hora BETWEEN NOW() + INTERVAL ? HOUR - INTERVAL 30 MINUTE
                              AND NOW() + INTERVAL ? HOUR + INTERVAL 30 MINUTE
         -- Se compara por los últimos 9 dígitos: Meta guarda el número con código de país (51…)
         AND RIGHT(REPLACE(REPLACE(REPLACE(p.telefono,' ',''),'-',''),'+',''), 9) NOT IN (
           SELECT DISTINCT RIGHT(REPLACE(REPLACE(REPLACE(telefono,' ',''),'-',''),'+',''), 9) FROM wa_mensajes_log
           WHERE tipo = 'recordatorio_cita'
             AND estado IN ('enviado','entregado','leido')
             AND enviado_at > NOW() - INTERVAL 1 DAY
         )`,
      [horas, horas]
    );
    console.log(`[Meta Citas] ${tenant.slug}: ${citas.length} recordatorios a ${horas}h`);

    for (const cita of citas) {
      if (!cita.telefono) continue;
      const tipoCita = cita.tipo_cita || 'medica';
      const uso      = TIPO_CITA_USO[tipoCita] || 'recordatorio_cita';
      try {
        const res = await enviarRecordatorio(tenant, cfg, {
          usos         : [uso, 'recordatorio_cita'],
          datos        : { nombre: cita.propietario, mascota: cita.mascota, fecha: fDate(cita.fecha_hora, tz), hora: fHora(cita.fecha_hora, tz) },
          telefono     : cita.telefono,
          tipoLog      : 'recordatorio_cita',
          propietarioId: cita.propietario_id,
        });
        if (res === 'omitido') continue;
        if (res === 'enviado') console.log(`[Meta Citas] ✅ ${tenant.slug} → ${cita.telefono} (${tipoCita})`);
      } catch (e) {
        console.error(`[Meta Citas] ❌ ${tenant.slug} → ${cita.telefono}: ${e.message}`);
      }
      await esperar(1000);
    }
  }
}

// ── Recordatorios de VACUNAS ──────────────────────────────────
async function procesarVacunas(tenant, conn, cfg) {
  const rangos = [cfg.recordatorio_vacunas_dias || 7];
  if (cfg.recordatorio_vacunas_dias2) rangos.push(cfg.recordatorio_vacunas_dias2);

  for (const dias of rangos) {
    const [vacunas] = await conn.execute(
      `SELECT v.id, v.nombre, v.proxima_dosis, p.id AS propietario_id,
              m.nombre AS mascota, ${NOMBRE_PROPIETARIO} AS propietario, p.telefono
       FROM vacunas v
       JOIN mascotas m ON m.id = v.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       WHERE v.notificado = 0
         AND v.proxima_dosis BETWEEN CURDATE() + INTERVAL ? DAY - INTERVAL 1 DAY
                                 AND CURDATE() + INTERVAL ? DAY + INTERVAL 1 DAY
         AND p.telefono IS NOT NULL`,
      [dias, dias]
    );
    console.log(`[Meta Vacunas] ${tenant.slug}: ${vacunas.length} recordatorios a ${dias} días`);

    for (const vac of vacunas) {
      if (!vac.telefono) continue;
      try {
        const res = await enviarRecordatorio(tenant, cfg, {
          usos         : ['recordatorio_vacuna'],
          datos        : { nombre: vac.propietario, mascota: vac.mascota, vacuna: vac.nombre, fecha: fDate(vac.proxima_dosis, tenant.zona_horaria) },
          telefono     : vac.telefono,
          tipoLog      : 'recordatorio_vacuna',
          propietarioId: vac.propietario_id,
        });
        if (res === 'omitido') continue;
        // 'fallido' también se marca: Meta lo rechazó de forma definitiva
        await conn.execute('UPDATE vacunas SET notificado=1 WHERE id=?', [vac.id]);
        if (res === 'enviado') console.log(`[Meta Vacunas] ✅ ${tenant.slug} → ${vac.telefono}`);
      } catch (e) {
        console.error(`[Meta Vacunas] ❌ ${tenant.slug}: ${e.message}`);
      }
      await esperar(1000);
    }
  }
}

// ── Recordatorios de DESPARASITACIONES ───────────────────────
async function procesarDesparasitaciones(tenant, conn, cfg) {
  const rangos = [cfg.recordatorio_vacunas_dias || 7];
  if (cfg.recordatorio_vacunas_dias2) rangos.push(cfg.recordatorio_vacunas_dias2);

  for (const dias of rangos) {
    const [desp] = await conn.execute(
      `SELECT d.id, d.producto, d.proxima_dosis, p.id AS propietario_id,
              m.nombre AS mascota, ${NOMBRE_PROPIETARIO} AS propietario, p.telefono
       FROM desparasitaciones d
       JOIN mascotas m ON m.id = d.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       WHERE d.notificado = 0
         AND d.proxima_dosis BETWEEN CURDATE() + INTERVAL ? DAY - INTERVAL 1 DAY
                                 AND CURDATE() + INTERVAL ? DAY + INTERVAL 1 DAY
         AND p.telefono IS NOT NULL`,
      [dias, dias]
    ).catch(() => [[]]);
    const rows = desp || [];
    console.log(`[Meta Desparasitaciones] ${tenant.slug}: ${rows.length} recordatorios a ${dias} días`);

    for (const d of rows) {
      if (!d.telefono) continue;
      try {
        const res = await enviarRecordatorio(tenant, cfg, {
          usos         : ['recordatorio_desparasitacion'],
          datos        : { nombre: d.propietario, mascota: d.mascota, producto: d.producto || 'su desparasitante', fecha: fDate(d.proxima_dosis, tenant.zona_horaria) },
          telefono     : d.telefono,
          tipoLog      : 'recordatorio_vacuna',
          propietarioId: d.propietario_id,
        });
        if (res === 'omitido') continue;
        await conn.execute('UPDATE desparasitaciones SET notificado=1 WHERE id=?', [d.id]);
        if (res === 'enviado') console.log(`[Meta Desparasitaciones] ✅ ${tenant.slug} → ${d.telefono}`);
      } catch (e) {
        console.error(`[Meta Desparasitaciones] ❌ ${tenant.slug}: ${e.message}`);
      }
      await esperar(1000);
    }
  }
}

// ── Proceso principal ─────────────────────────────────────────
async function procesarRecordatorios() {
  console.log(`[Meta Recordatorios] Iniciando ciclo: ${new Date().toLocaleString('es-PE')}`);
  try {
    const tenants = await masterQuery(SQL_TENANTS_META);
    console.log(`[Meta Recordatorios] Clínicas con Meta: ${tenants.length}`);

    for (const tenant of tenants) {
      let conn;
      try {
        conn = await getTenantConn(tenant);
        const [[cfg]] = await conn.execute('SELECT * FROM wa_config LIMIT 1');
        if (!cfg?.activo) {
          console.log(`[Meta Recordatorios] ${tenant.slug}: recordatorios inactivos`);
          continue;
        }
        tenant.plantillas = await plantillasAprobadas(conn);
        tenant._avisados  = new Set();

        if (cfg.recordatorio_citas_activo)             await procesarCitas(tenant, conn, cfg);
        if (cfg.recordatorio_vacunas_activo)           await procesarVacunas(tenant, conn, cfg);
        if (cfg.recordatorio_desparasitaciones_activo) await procesarDesparasitaciones(tenant, conn, cfg);
      } catch (e) {
        console.error(`[Meta Recordatorios] Error ${tenant.slug}: ${e.message}`);
      } finally {
        await conn?.end().catch(() => {});
      }
    }
  } catch (e) {
    console.error('[Meta Recordatorios] Error general:', e.message);
  }
  console.log('[Meta Recordatorios] Ciclo completado');
}

// ── Scheduler — cada 30 minutos, sin solaparse ────────────────
const INTERVALO = 30 * 60 * 1000;

async function loop() {
  console.log('[Meta Recordatorios] ✅ Activo — cada 30 minutos');
  while (true) {
    const inicio = Date.now();
    await procesarRecordatorios();
    await esperar(Math.max(INTERVALO - (Date.now() - inicio), 60 * 1000));
  }
}

if (require.main === module) loop();

module.exports = { procesarRecordatorios };
