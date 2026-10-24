'use strict';

/**
 * VetClinic SaaS — Cron de Recordatorios WhatsApp
 * Revisa cada 30 minutos citas, vacunas y desparasitaciones pendientes.
 *
 * Canal de envío por clínica:
 *   · Conectada a Meta (API oficial) y con la pantalla Meta habilitada → plantilla aprobada por Meta
 *     (vía wa-meta, puerto interno 5003). Sin plantilla aprobada para ese recordatorio, no se envía.
 *   · Si no → WhatsApp por QR (wa-gateway), igual que siempre.
 */

const mysql = require('mysql2/promise');
const http  = require('http');
const path  = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const WA_GATEWAY   = process.env.WA_GATEWAY_URL  || 'http://localhost:5001';
const INTERNAL_KEY = process.env.WA_INTERNAL_KEY || 'wa-internal-secret-2026';
const WA_META_INTERNO = process.env.WA_META_INTERNAL_URL || 'http://127.0.0.1:5003';

const masterPool = mysql.createPool({
  host    : process.env.MASTER_DB_HOST,
  port    : process.env.MASTER_DB_PORT || 3306,
  user    : process.env.MASTER_DB_USER,
  password: process.env.MASTER_DB_PASS,
  database: process.env.MASTER_DB_NAME,
  connectionLimit: 3,
});

async function masterQuery(sql, params = []) {
  const [rows] = await masterPool.execute(sql, params);
  return rows;
}

const TZ_OFFSETS = {
  'America/Lima'                   : '-05:00',
  'America/Bogota'                 : '-05:00',
  'America/Guayaquil'              : '-05:00',
  'America/Mexico_City'            : '-06:00',
  'America/Santiago'               : '-04:00',
  'America/Argentina/Buenos_Aires' : '-03:00',
  'America/Caracas'                : '-04:00',
  'America/La_Paz'                 : '-04:00',
  'America/Asuncion'               : '-04:00',
  'America/Montevideo'             : '-03:00',
  'America/Panama'                 : '-05:00',
  'America/Guatemala'              : '-06:00',
  'America/New_York'               : '-05:00',
  'America/Chicago'                : '-06:00',
  'America/Denver'                 : '-07:00',
  'America/Los_Angeles'            : '-08:00',
  'Europe/Madrid'                  : '+01:00',
};

function getTimezoneOffset(ianaZone) {
  return TZ_OFFSETS[ianaZone] || '-05:00';
}

async function getTenantConn(t) {
  const tzOffset = getTimezoneOffset(t.zona_horaria || 'America/Lima');
  return mysql.createConnection({
    host    : t.db_host,
    port    : t.db_port || 3306,
    user    : t.db_user,
    password: t.db_pass,
    database: t.db_name,
    timezone: tzOffset,
  });
}

function callGateway(method, endpath, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const url     = new URL(WA_GATEWAY + endpath);
    const options = {
      hostname: url.hostname,
      port    : url.port || 5001,
      path    : url.pathname,
      method,
      headers: {
        'Content-Type'  : 'application/json',
        'x-internal-key': INTERNAL_KEY,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Envío por Meta (wa-meta interno) ──────────────────────────
function callMeta(body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const url     = new URL(WA_META_INTERNO + '/interno/enviar-plantilla');
    const req = http.request({
      hostname: url.hostname, port: url.port || 5003, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY, 'Content-Length': Buffer.byteLength(bodyStr) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { let j = {}; try { j = JSON.parse(data); } catch {} resolve({ status: res.statusCode, ...j }); });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout wa-meta')); });
    req.write(bodyStr);
    req.end();
  });
}

// Plantillas de Meta aprobadas de la clínica, por uso (se lee una vez por ciclo)
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
 * Envía un recordatorio por el canal de la clínica.
 * Devuelve 'enviado', 'fallido' (Meta lo rechazó de forma definitiva: no se reintenta)
 * u 'omitido' (sin plantilla aprobada: se reintentará cuando la aprueben).
 * Lanza error si conviene reintentar en el próximo ciclo.
 */
async function enviarRecordatorio(tenant, cfg, { usos, datos, telefono, tipoLog, mensajeQR, propietarioId }) {
  if (tenant.usa_meta) {
    const p = usos.map(u => tenant.plantillas[u]).find(Boolean);
    if (!p) {
      const clave = usos[0];
      if (!tenant._avisados.has(clave)) {
        tenant._avisados.add(clave);
        console.log(`[WA Meta] ⚠️ ${tenant.slug}: sin plantilla aprobada para "${clave}" — no se envía (apruébala en WhatsApp Meta → Recordatorios)`);
      }
      return 'omitido';
    }
    const variables = p.variables.map(k => datos[k] || '-');
    const resumen   = p.cuerpo.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => variables[n - 1] || '');
    const r = await callMeta({
      tenantId: tenant.id, telefono, plantilla: p.nombre, idioma: p.idioma, variables,
      tipo: tipoLog, propietarioId: propietarioId || null, resumen, codigoPais: cfg.codigo_pais || '+51',
    });
    if (!r.success) {
      if (r.reintentar === false) {
        console.error(`[WA Meta] ❌ ${tenant.slug} → ${telefono}: ${r.message}`);
        return 'fallido';
      }
      throw new Error(r.message || 'Meta no envió el mensaje');
    }
    return 'enviado';
  }

  await callGateway('POST', '/wa/enviar', {
    tenantId: tenant.id, telefono, mensaje: mensajeQR, propietarioId: propietarioId || null,
    tipo: tipoLog, codigoPais: cfg.codigo_pais || '+51',
  });
  return 'enviado';
}

function rellenarPlantilla(plantilla, vars) {
  return plantilla
    .replace(/\[nombre\]/gi,   vars.nombre   || '')
    .replace(/\[mascota\]/gi,  vars.mascota  || '')
    .replace(/\[fecha\]/gi,    vars.fecha    || '')
    .replace(/\[hora\]/gi,     vars.hora     || '')
    .replace(/\[vacuna\]/gi,   vars.vacuna   || '')
    .replace(/\[clinica\]/gi,  vars.clinica  || '')
    .replace(/\[telefono\]/gi, vars.telefono || '');
}

function fDate(d, tz) {
  return new Date(d).toLocaleDateString('es-PE', {
    day:'2-digit', month:'long', year:'numeric',
    timeZone: tz || 'America/Lima',
  });
}

function fHora(d, tz) {
  return new Date(d).toLocaleTimeString('es-PE', {
    hour:'2-digit', minute:'2-digit',
    timeZone: tz || 'America/Lima',
  });
}

// Mapa tipo_cita → tipo plantilla WA
const TIPO_CITA_PLANTILLA = {
  medica          : 'recordatorio_cita',
  vacuna          : 'recordatorio_cita_vacuna',
  desparasitacion : 'recordatorio_cita_desparasitacion',
  estetica        : 'recordatorio_cita_estetica',
};

const FALLBACK_CITA = {
  medica          : '🐾 Hola [nombre], recuerda la cita médica de *[mascota]* el *[fecha]* a las *[hora]* en *[clinica]*.',
  vacuna          : '💉 Hola [nombre], recuerda la cita de vacunación de *[mascota]* el *[fecha]* a las *[hora]* en *[clinica]*.',
  desparasitacion : '🐛 Hola [nombre], recuerda la cita de desparasitación de *[mascota]* el *[fecha]* a las *[hora]* en *[clinica]*.',
  estetica        : '✂️ Hola [nombre], recuerda la cita de estética de *[mascota]* el *[fecha]* a las *[hora]* en *[clinica]*.',
};

// ── Recordatorios de CITAS ────────────────────────────────────
async function procesarRecordatoriosCitas(tenant, conn, cfg, clinica) {
  const horas1 = cfg.recordatorio_citas_horas || 24;
  const horas2 = cfg.recordatorio_citas_horas2;
  const rangos = [horas1];
  if (horas2) rangos.push(horas2);

  for (const horas of rangos) {
    const [citas] = await conn.execute(
      `SELECT c.id, c.fecha_hora, c.motivo, c.tipo_cita,
              m.nombre AS mascota,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.nombre, p.apellido)),''), p.razon_social) AS propietario,
              p.telefono,
              u.nombre AS veterinario
       FROM citas c
       JOIN mascotas m ON m.id = c.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       JOIN usuarios u ON u.id = c.veterinario_id
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

    console.log(`[WA Citas] ${tenant.slug}: ${citas.length} recordatorios a ${horas}h`);

    for (const cita of citas) {
      if (!cita.telefono) continue;
      try {
        const tipoCita      = cita.tipo_cita || 'medica';
        const tipoPlantilla = TIPO_CITA_PLANTILLA[tipoCita] || 'recordatorio_cita';
        const tz            = tenant.zona_horaria || 'America/Lima';

        // 1. Buscar plantilla específica del tipo de cita
        const [[plantillaEspecifica]] = await conn.execute(
          'SELECT contenido FROM wa_plantillas WHERE tipo = ? AND activo = 1 LIMIT 1',
          [tipoPlantilla]
        );
        let contenido = plantillaEspecifica?.contenido;

        // 2. Fallback a plantilla genérica
        if (!contenido && tipoPlantilla !== 'recordatorio_cita') {
          const [[plantillaGenerica]] = await conn.execute(
            "SELECT contenido FROM wa_plantillas WHERE tipo = 'recordatorio_cita' AND activo = 1 LIMIT 1"
          );
          contenido = plantillaGenerica?.contenido;
        }

        // 3. Fallback hardcodeado
        if (!contenido) {
          contenido = FALLBACK_CITA[tipoCita] || FALLBACK_CITA.medica;
        }

        const msg = rellenarPlantilla(contenido, {
          nombre  : cita.propietario,
          mascota : cita.mascota,
          fecha   : fDate(cita.fecha_hora, tz),
          hora    : fHora(cita.fecha_hora, tz),
          clinica,
          telefono: tenant.tel_clinica || '',
        });

        const res = await enviarRecordatorio(tenant, cfg, {
          usos         : [tipoPlantilla, 'recordatorio_cita'],
          datos        : { nombre: cita.propietario, mascota: cita.mascota, fecha: fDate(cita.fecha_hora, tz), hora: fHora(cita.fecha_hora, tz) },
          telefono     : cita.telefono,
          tipoLog      : 'recordatorio_cita',
          mensajeQR    : msg,
          propietarioId: tenant.usa_meta ? cita.propietario_id : null,
        });
        if (res !== 'enviado') continue;

        console.log(`[WA Citas] ✅ ${tenant.slug} → ${cita.telefono} (${tipoCita}${tenant.usa_meta ? ', Meta' : ''})`);
      } catch (e) {
        console.error(`[WA Citas] ❌ ${tenant.slug} → ${cita.telefono}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ── Recordatorios de VACUNAS ──────────────────────────────────
async function procesarRecordatoriosVacunas(tenant, conn, cfg, clinica) {
  const dias1 = cfg.recordatorio_vacunas_dias || 7;
  const dias2 = cfg.recordatorio_vacunas_dias2;
  const rangos = [dias1];
  if (dias2) rangos.push(dias2);

  for (const dias of rangos) {
    const [vacunas] = await conn.execute(
      `SELECT v.id, v.nombre, v.proxima_dosis, p.id AS propietario_id,
              m.nombre AS mascota,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.nombre, p.apellido)),''), p.razon_social) AS propietario,
              p.telefono
       FROM vacunas v
       JOIN mascotas m ON m.id = v.mascota_id
       JOIN propietarios p ON p.id = m.propietario_id
       WHERE v.notificado = 0
         AND v.proxima_dosis BETWEEN CURDATE() + INTERVAL ? DAY - INTERVAL 1 DAY
                                 AND CURDATE() + INTERVAL ? DAY + INTERVAL 1 DAY
         AND p.telefono IS NOT NULL`,
      [dias, dias]
    );

    console.log(`[WA Vacunas] ${tenant.slug}: ${vacunas.length} recordatorios a ${dias} días`);

    for (const vac of vacunas) {
      if (!vac.telefono) continue;
      try {
        const [[plantilla]] = await conn.execute(
          "SELECT contenido FROM wa_plantillas WHERE tipo='recordatorio_vacuna' AND activo=1 LIMIT 1"
        );
        const msg = rellenarPlantilla(
          plantilla?.contenido || '💉 Hola [nombre], [mascota] tiene pendiente su vacuna [vacuna]. ¡Agenda tu cita en [clinica]!',
          { nombre: vac.propietario, mascota: vac.mascota, vacuna: vac.nombre, clinica }
        );

        const res = await enviarRecordatorio(tenant, cfg, {
          usos         : ['recordatorio_vacuna'],
          datos        : { nombre: vac.propietario, mascota: vac.mascota, vacuna: vac.nombre, fecha: fDate(vac.proxima_dosis, tenant.zona_horaria) },
          telefono     : vac.telefono,
          tipoLog      : 'recordatorio_vacuna',
          mensajeQR    : msg,
          propietarioId: tenant.usa_meta ? vac.propietario_id : null,
        });
        if (res === 'omitido') continue;

        await conn.execute('UPDATE vacunas SET notificado=1 WHERE id=?', [vac.id]);
        if (res === 'enviado') console.log(`[WA Vacunas] ✅ ${tenant.slug} → ${vac.telefono}${tenant.usa_meta ? ' (Meta)' : ''}`);
      } catch (e) {
        console.error(`[WA Vacunas] ❌ ${tenant.slug}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ── Recordatorios de DESPARASITACIONES ───────────────────────
async function procesarRecordatoriosDesparasitaciones(tenant, conn, cfg, clinica) {
  const dias1 = cfg.recordatorio_vacunas_dias || 7;
  const dias2 = cfg.recordatorio_vacunas_dias2;
  const rangos = [dias1];
  if (dias2) rangos.push(dias2);

  for (const dias of rangos) {
    const [desp] = await conn.execute(
      `SELECT d.id, d.tipo, d.producto, d.proxima_dosis, p.id AS propietario_id,
              m.nombre AS mascota,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.nombre, p.apellido)),''), p.razon_social) AS propietario,
              p.telefono
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
    console.log(`[WA Desparasitaciones] ${tenant.slug}: ${rows.length} recordatorios a ${dias} días`);

    for (const d of rows) {
      if (!d.telefono) continue;
      try {
        const tipoLabel = { interna: 'interna', externa: 'externa', interna_externa: 'interna y externa' };
        const msg = `🐛 Hola ${d.propietario}, recuerda que *${d.mascota}* tiene pendiente su desparasitación ${tipoLabel[d.tipo]||''} con *${d.producto}*. Contáctanos en *${clinica}* para coordinar.`;

        const res = await enviarRecordatorio(tenant, cfg, {
          usos         : ['recordatorio_desparasitacion'],
          datos        : { nombre: d.propietario, mascota: d.mascota, producto: d.producto || 'su desparasitante', fecha: fDate(d.proxima_dosis, tenant.zona_horaria) },
          telefono     : d.telefono,
          tipoLog      : 'recordatorio_vacuna',
          mensajeQR    : msg,
          propietarioId: tenant.usa_meta ? d.propietario_id : null,
        });
        if (res === 'omitido') continue;

        await conn.execute('UPDATE desparasitaciones SET notificado=1 WHERE id=?', [d.id]);
        if (res === 'enviado') console.log(`[WA Desparasitaciones] ✅ ${tenant.slug} → ${d.telefono}${tenant.usa_meta ? ' (Meta)' : ''}`);
      } catch (e) {
        console.error(`[WA Desparasitaciones] ❌ ${tenant.slug}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ── Proceso principal ─────────────────────────────────────────
async function procesarRecordatorios() {
  console.log(`[WA Recordatorios] Iniciando ciclo: ${new Date().toLocaleString('es-PE')}`);

  try {
    let tenants;
    try {
      // Clínicas con WhatsApp por QR conectado o con Meta conectado (y la pantalla Meta habilitada)
      tenants = await masterQuery(
        `SELECT t.id, t.slug, t.db_host, t.db_port, t.db_user, t.db_pass, t.db_name,
                tc.nombre_clinica, tc.telefono AS tel_clinica, tc.zona_horaria,
                (wmc.estado = 'conectado' AND COALESCE(wcg.ver_meta, 0) = 1) AS usa_meta
         FROM tenants t
         JOIN tenant_config tc          ON tc.tenant_id  = t.id
         JOIN wa_config_global wcg      ON wcg.tenant_id = t.id
         LEFT JOIN wa_sesiones ws       ON ws.tenant_id  = t.id
         LEFT JOIN wa_meta_cuentas wmc  ON wmc.tenant_id = t.id
         WHERE t.activo = 1 AND wcg.activo = 1
           AND (ws.estado = 'conectado' OR (wmc.estado = 'conectado' AND COALESCE(wcg.ver_meta, 0) = 1))`
      );
    } catch (e) {
      // Base maestra sin las tablas de Meta: solo QR, como antes
      tenants = await masterQuery(
        `SELECT t.id, t.slug, t.db_host, t.db_port, t.db_user, t.db_pass, t.db_name,
                tc.nombre_clinica, tc.telefono AS tel_clinica, tc.zona_horaria, 0 AS usa_meta
         FROM tenants t
         JOIN tenant_config tc     ON tc.tenant_id  = t.id
         JOIN wa_sesiones ws       ON ws.tenant_id  = t.id
         JOIN wa_config_global wcg ON wcg.tenant_id = t.id
         WHERE t.activo = 1 AND ws.estado = 'conectado' AND wcg.activo = 1`
      );
    }

    console.log(`[WA Recordatorios] Tenants activos con WA: ${tenants.length}`);

    for (const tenant of tenants) {
      let conn;
      try {
        conn = await getTenantConn(tenant);

        const [[cfg]] = await conn.execute('SELECT * FROM wa_config LIMIT 1');
        if (!cfg?.activo) {
          console.log(`[WA Recordatorios] ${tenant.slug}: WA inactivo en config tenant`);
          continue;
        }

        const clinica = tenant.nombre_clinica || 'VetClinic';
        tenant.usa_meta   = !!Number(tenant.usa_meta);
        tenant.plantillas = tenant.usa_meta ? await plantillasAprobadas(conn) : {};
        tenant._avisados  = new Set();

        if (cfg.recordatorio_citas_activo) {
          await procesarRecordatoriosCitas(tenant, conn, cfg, clinica);
        }
        if (cfg.recordatorio_vacunas_activo) {
          await procesarRecordatoriosVacunas(tenant, conn, cfg, clinica);
        }
        if (cfg.recordatorio_desparasitaciones_activo) {
          await procesarRecordatoriosDesparasitaciones(tenant, conn, cfg, clinica);
        }
      } catch (e) {
        console.error(`[WA Recordatorios] Error ${tenant.slug}: ${e.message}`);
      } finally {
        await conn?.end();
      }
    }
  } catch (e) {
    console.error('[WA Recordatorios] Error general:', e.message);
  }

  console.log(`[WA Recordatorios] Ciclo completado`);
}

// ── Scheduler — cada 30 minutos ───────────────────────────────
const INTERVALO = 30 * 60 * 1000;

procesarRecordatorios();
setInterval(procesarRecordatorios, INTERVALO);

console.log(`[WA Recordatorios] ✅ Activo — cada 30 minutos`);

module.exports = { procesarRecordatorios };