'use strict';

/**
 * VetClinic SaaS — Cron de Recordatorios WhatsApp
 * Revisa cada 30 minutos citas y vacunas pendientes
 */

const mysql = require('mysql2/promise');
const http  = require('http');
const path  = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const WA_GATEWAY   = process.env.WA_GATEWAY_URL  || 'http://localhost:5001';
const INTERNAL_KEY = process.env.WA_INTERNAL_KEY || 'wa-internal-secret-2026';

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

// Convierte zona horaria IANA a offset MySQL (+HH:MM)
function getTimezoneOffset(ianaZone) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaZone || 'America/Lima',
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(now);
    const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-5';
    const match = offsetPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
    if (!match) return '-05:00';
    const sign    = match[1];
    const hours   = match[2].padStart(2, '0');
    const minutes = (match[3] || '00').padStart(2, '0');
    return `${sign}${hours}:${minutes}`;
  } catch {
    return '-05:00';
  }
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

function callGateway(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const url     = new URL(WA_GATEWAY + path);
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

// ── Recordatorios de CITAS ────────────────────────────────────
async function procesarRecordatoriosCitas(tenant, conn, cfg, clinica) {
  const horas1 = cfg.recordatorio_citas_horas || 24;
  const horas2 = cfg.recordatorio_citas_horas2;
  const rangos = [horas1];
  if (horas2) rangos.push(horas2);

  for (const horas of rangos) {
    const [citas] = await conn.execute(
      `SELECT c.id, c.fecha_hora, c.motivo,
              m.nombre AS mascota,
              CONCAT(p.nombre,' ',p.apellido) AS propietario,
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
         AND p.telefono NOT IN (
           SELECT DISTINCT telefono FROM wa_mensajes_log
           WHERE tipo = 'recordatorio_cita'
             AND estado = 'enviado'
             AND enviado_at > NOW() - INTERVAL 1 DAY
         )`,
      [horas, horas]
    );

    console.log(`[WA Citas] ${tenant.slug}: ${citas.length} recordatorios a ${horas}h`);

    for (const cita of citas) {
      if (!cita.telefono) continue;
      try {
        const [[plantilla]] = await conn.execute(
          "SELECT contenido FROM wa_plantillas WHERE tipo='recordatorio_cita' AND activo=1 LIMIT 1"
        );
        const tz  = tenant.zona_horaria || 'America/Lima';
        const msg = rellenarPlantilla(
          plantilla?.contenido || '🐾 Hola [nombre], recuerda tu cita para [mascota] el [fecha] a las [hora] en [clinica].',
          {
            nombre  : cita.propietario,
            mascota : cita.mascota,
            fecha   : fDate(cita.fecha_hora, tz),
            hora    : fHora(cita.fecha_hora, tz),
            clinica,
          }
        );

        await callGateway('POST', '/wa/enviar', {
          tenantId     : tenant.id,
          telefono     : cita.telefono,
          mensaje      : msg,
          propietarioId: null,
          tipo         : 'recordatorio_cita',
          codigoPais   : cfg.codigo_pais || '+51',
        });

        console.log(`[WA Citas] ✅ ${tenant.slug} → ${cita.telefono}`);
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
      `SELECT v.id, v.nombre, v.proxima_dosis,
              m.nombre AS mascota,
              CONCAT(p.nombre,' ',p.apellido) AS propietario,
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
          {
            nombre  : vac.propietario,
            mascota : vac.mascota,
            vacuna  : vac.nombre,
            clinica,
          }
        );

        await callGateway('POST', '/wa/enviar', {
          tenantId  : tenant.id,
          telefono  : vac.telefono,
          mensaje   : msg,
          tipo      : 'recordatorio_vacuna',
          codigoPais: cfg.codigo_pais || '+51',
        });

        await conn.execute('UPDATE vacunas SET notificado=1 WHERE id=?', [vac.id]);
        console.log(`[WA Vacunas] ✅ ${tenant.slug} → ${vac.telefono}`);
      } catch (e) {
        console.error(`[WA Vacunas] ❌ ${tenant.slug}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ── Proceso principal ─────────────────────────────────────────
async function procesarRecordatorios() {
  console.log(`[WA Recordatorios] Iniciando ciclo: ${new Date().toLocaleString('es-PE')}`);

  try {
    const tenants = await masterQuery(
      `SELECT t.id, t.slug, t.db_host, t.db_port, t.db_user, t.db_pass, t.db_name,
              tc.nombre_clinica, tc.telefono AS tel_clinica, tc.zona_horaria
       FROM tenants t
       JOIN tenant_config tc ON tc.tenant_id = t.id
       JOIN wa_sesiones ws ON ws.tenant_id = t.id
       JOIN wa_config_global wcg ON wcg.tenant_id = t.id
       WHERE t.activo = 1 AND ws.estado = 'conectado' AND wcg.activo = 1`
    );

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

        if (cfg.recordatorio_citas_activo) {
          await procesarRecordatoriosCitas(tenant, conn, cfg, clinica);
        }
        if (cfg.recordatorio_vacunas_activo) {
          await procesarRecordatoriosVacunas(tenant, conn, cfg, clinica);
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