'use strict';

/**
 * VetNetcodip — Procesador de campañas por WhatsApp Meta (API oficial)
 * Envía las campañas con proveedor='meta' usando su plantilla aprobada.
 *
 * Independiente de wa-gateway (QR / Baileys), que procesa solo las de proveedor='qr'.
 * La pantalla WhatsApp Meta consulta el avance por la API (no usa sockets del gateway).
 *
 * - Loop con await: el siguiente ciclo solo arranca cuando el anterior terminó
 * - Reserva atómica del contacto con SELECT ... FOR UPDATE SKIP LOCKED
 * - Límite diario por campaña (los números nuevos de Meta empiezan con 250 clientes/día)
 * - Horario de envío: el de wa_config de la clínica
 */

const { masterQuery, getTenantConn, SQL_TENANTS_META, enviarPlantilla, esperar } = require('./cron-comun');

const LIMITE_DIA = parseInt(process.env.WA_META_CAMPANA_LIMITE_DIA || '250', 10);
const DELAY_MS   = parseInt(process.env.WA_META_CAMPANA_DELAY_MS   || '1000', 10);

async function horarioCampana(conn) {
  const [[cfg]] = await conn.execute('SELECT campana_hora_inicio, campana_hora_fin FROM wa_config LIMIT 1');
  return { inicio: cfg?.campana_hora_inicio || '08:00:00', fin: cfg?.campana_hora_fin || '20:00:00' };
}

// Hora actual en la zona horaria de la clínica (no la del servidor)
function dentroDeHorario(horaInicio, horaFin, zona) {
  const opts = { hour12: false, hour: '2-digit', minute: '2-digit' };
  let ahora;
  try { ahora = new Date().toLocaleTimeString('en-GB', { ...opts, timeZone: zona || 'America/Lima' }); }
  catch { ahora = new Date().toLocaleTimeString('en-GB', { ...opts, timeZone: 'America/Lima' }); }
  ahora += ':00';
  return ahora >= String(horaInicio).padStart(8, '0') && ahora <= String(horaFin).padStart(8, '0');
}

async function enviadosHoy(conn, campanaId) {
  const [[{ n }]] = await conn.execute(
    `SELECT COUNT(*) AS n FROM wa_campana_contactos
     WHERE campana_id = ? AND estado = 'enviado' AND DATE(enviado_at) = CURDATE()`,
    [campanaId]
  );
  return Number(n || 0);
}

// Misma lógica que sqlSegmento de backend/src/routes/wa-meta.routes.js (mantener iguales)
async function obtenerContactos(conn, campana) {
  const nombre = `COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.nombre, p.apellido)),''), p.razon_social)`;
  const base = (joins, where, params = []) => conn.execute(
    `SELECT p.id, ${nombre} AS nombre, p.telefono
     FROM propietarios p ${joins}
     WHERE p.telefono IS NOT NULL AND TRIM(p.telefono) <> '' ${where}
     GROUP BY p.id`, params
  ).then(([r]) => r);

  switch (campana.segmento) {
    case 'todos':
      return base('LEFT JOIN mascotas m ON m.propietario_id = p.id', '');
    case 'por_especie':
      return base('JOIN mascotas m ON m.propietario_id = p.id', 'AND m.especie = ?', [campana.segmento_valor || '']);
    case 'vacunas_vencidas':
      return base('JOIN mascotas m ON m.propietario_id = p.id JOIN vacunas v ON v.mascota_id = m.id',
                  'AND v.proxima_dosis < CURDATE() AND v.notificado = 0');
    case 'citas_semana':
      return base('JOIN mascotas m ON m.propietario_id = p.id JOIN citas c ON c.mascota_id = m.id',
                  "AND c.fecha_hora BETWEEN NOW() AND NOW() + INTERVAL 7 DAY AND c.estado IN ('pendiente','confirmada')");
    case 'sin_citas_60d':
      return base('LEFT JOIN mascotas m ON m.propietario_id = p.id',
                  `AND NOT EXISTS (SELECT 1 FROM citas c2 JOIN mascotas m2 ON m2.id = c2.mascota_id
                                   WHERE m2.propietario_id = p.id AND c2.fecha_hora >= NOW() - INTERVAL 60 DAY)`);
    default:
      return [];
  }
}

async function cargarContactos(campana, conn) {
  const contactos = await obtenerContactos(conn, campana);
  if (!contactos.length) {
    await conn.execute("UPDATE wa_campanas SET estado='completada', completada_at=NOW() WHERE id=?", [campana.id]);
    return false;
  }
  for (const c of contactos) {
    await conn.execute(
      'INSERT IGNORE INTO wa_campana_contactos (campana_id, propietario_id, telefono, nombre) VALUES (?,?,?,?)',
      [campana.id, c.id, c.telefono, c.nombre]
    );
  }
  await conn.execute('UPDATE wa_campanas SET total=? WHERE id=?', [contactos.length, campana.id]);
  console.log(`[Meta Campañas] ${contactos.length} contactos cargados para campaña #${campana.id}`);
  return true;
}

// Reserva el siguiente contacto pendiente (lo marca 'enviado' dentro de la transacción)
async function reservarContacto(conn, campanaId) {
  let id;
  await conn.beginTransaction();
  try {
    const [[fila]] = await conn.execute(
      `SELECT id FROM wa_campana_contactos
       WHERE campana_id=? AND estado='pendiente'
       ORDER BY id ASC LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [campanaId]
    );
    if (!fila) { await conn.commit(); return null; }
    await conn.execute("UPDATE wa_campana_contactos SET estado='enviado', enviado_at=NOW() WHERE id=?", [fila.id]);
    await conn.commit();
    id = fila.id;
  } catch (e) {
    await conn.rollback();
    throw e;
  }
  const [[datos]] = await conn.execute(
    `SELECT wcc.id, wcc.propietario_id, wcc.telefono, wcc.nombre,
            GROUP_CONCAT(m.nombre ORDER BY m.id SEPARATOR ', ') AS mascotas
     FROM wa_campana_contactos wcc
     LEFT JOIN mascotas m ON m.propietario_id = wcc.propietario_id
     WHERE wcc.id=?
     GROUP BY wcc.id`,
    [id]
  );
  return datos || null;
}

// Envía a UN contacto de la campaña (se llama una vez por campaña en cada ciclo)
async function procesarCampana(campana, conn, tenant) {
  try {
    const hoy = await enviadosHoy(conn, campana.id);
    if (hoy >= LIMITE_DIA) {
      console.log(`[Meta Campañas] ⏳ Campaña #${campana.id} — límite diario alcanzado (${hoy}/${LIMITE_DIA}). Retomará mañana.`);
      return;
    }

    // La plantilla tiene que seguir aprobada
    if (!campana.nombre_meta || campana.meta_estado !== 'aprobada') {
      await conn.execute("UPDATE wa_campanas SET estado='pausada', pausada_at=NOW() WHERE id=?", [campana.id]);
      console.log(`[Meta Campañas] ⏸️  Campaña #${campana.id} pausada: la plantilla no está aprobada (${campana.meta_estado || 'sin plantilla'})`);
      return;
    }

    const [[{ n }]] = await conn.execute('SELECT COUNT(*) AS n FROM wa_campana_contactos WHERE campana_id=?', [campana.id]);
    if (!n && !(await cargarContactos(campana, conn))) return;

    const contacto = await reservarContacto(conn, campana.id);
    if (!contacto) {
      const [[{ pendientes }]] = await conn.execute(
        "SELECT COUNT(*) AS pendientes FROM wa_campana_contactos WHERE campana_id=? AND estado='pendiente'", [campana.id]
      );
      if (!pendientes) {
        await conn.execute("UPDATE wa_campanas SET estado='completada', completada_at=NOW() WHERE id=?", [campana.id]);
        console.log(`[Meta Campañas] ✅ Completada: "${campana.nombre}" (${tenant.slug})`);
      }
      return;
    }

    // Pudo pausarse o cancelarse mientras tanto: el contacto vuelve a pendiente
    const [[actual]] = await conn.execute('SELECT estado FROM wa_campanas WHERE id=?', [campana.id]);
    if (!actual || actual.estado !== 'enviando') {
      await conn.execute("UPDATE wa_campana_contactos SET estado='pendiente', enviado_at=NULL WHERE id=?", [contacto.id]);
      return;
    }

    let mapeo = [];
    try { mapeo = JSON.parse(campana.meta_variables || '[]'); } catch { mapeo = []; }
    const datos = {
      nombre : contacto.nombre || 'cliente',
      mascota: contacto.mascotas || 'tu mascota',
      clinica: tenant.nombre_clinica || 'VetNetcodip',
    };
    const variables = mapeo.map(m => m.tipo === 'dato' ? (datos[m.valor] || '-') : String(m.valor || '-'));
    const resumen   = (campana.meta_cuerpo || campana.mensaje || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, i) => variables[i - 1] || '');

    const r = await enviarPlantilla({
      tenantId: tenant.id, telefono: contacto.telefono, plantilla: campana.nombre_meta,
      idioma: campana.meta_idioma || 'es', variables, tipo: 'campana', campanaId: campana.id,
      imagenMediaId: String(campana.imagen_url || '').startsWith('meta-media:') ? campana.imagen_url.slice(11) : null,
      propietarioId: contacto.propietario_id, resumen, codigoPais: '+51',
    });

    if (r.success) {
      await conn.execute(
        'UPDATE wa_campanas SET enviados=enviados+1, enviados_hoy=enviados_hoy+1, fecha_ultimo_envio=CURDATE() WHERE id=?',
        [campana.id]
      );
      console.log(`[Meta Campañas] ✅ → ${contacto.telefono} (${contacto.nombre})`);
    } else if (r.reintentar) {
      // Límite de Meta o falla temporal: vuelve a pendiente y se reintenta en el próximo ciclo
      await conn.execute(
        "UPDATE wa_campana_contactos SET estado='pendiente', enviado_at=NULL, error=? WHERE id=?",
        [String(r.message || '').substring(0, 255), contacto.id]
      );
      console.warn(`[Meta Campañas] ⏳ → ${contacto.telefono}: ${r.message} (se reintenta)`);
      await esperar(15000);
      return;
    } else {
      // Rechazo definitivo (número sin WhatsApp, etc.): no se reintenta
      await conn.execute(
        "UPDATE wa_campana_contactos SET estado='fallido', error=? WHERE id=?",
        [String(r.message || '').substring(0, 255), contacto.id]
      );
      await conn.execute('UPDATE wa_campanas SET fallidos=fallidos+1 WHERE id=?', [campana.id]);
      console.error(`[Meta Campañas] ❌ → ${contacto.telefono}: ${r.message}`);
    }

    await esperar(DELAY_MS);
  } catch (e) {
    console.error(`[Meta Campañas] Error campaña ${campana.id}:`, e.message);
  }
}

async function procesarTenant(tenant, conn) {
  try {
    // Activar las campañas programadas cuya fecha ya llegó
    await conn.execute(
      `UPDATE wa_campanas SET estado='enviando', iniciada_at=NOW()
       WHERE estado='programada' AND proveedor='meta' AND programada_at IS NOT NULL AND programada_at <= NOW()`
    );
  } catch { return; }   // clínica sin migración v18: no tiene campañas por Meta

  const [campanas] = await conn.execute(
    `SELECT c.id, c.nombre, c.mensaje, c.imagen_url, c.segmento, c.segmento_valor, c.meta_variables,
            p.nombre_meta, p.idioma AS meta_idioma, p.estado AS meta_estado, p.cuerpo AS meta_cuerpo
     FROM wa_campanas c
     LEFT JOIN wa_meta_plantillas p ON p.id = c.meta_plantilla_id
     WHERE c.estado = 'enviando' AND c.proveedor = 'meta'
     ORDER BY c.id ASC`
  );
  if (!campanas.length) return;

  const h = await horarioCampana(conn);
  if (!dentroDeHorario(h.inicio, h.fin, tenant.zona_horaria)) return;

  for (const campana of campanas) await procesarCampana(campana, conn, tenant);
}

async function procesarCampanas() {
  try {
    const tenants = await masterQuery(SQL_TENANTS_META);
    for (const tenant of tenants) {
      let conn;
      try {
        conn = await getTenantConn(tenant);
        await procesarTenant(tenant, conn);
      } catch (e) {
        console.error(`[Meta Campañas] Error ${tenant.slug}:`, e.message);
      } finally {
        if (conn) await conn.end().catch(() => {});
      }
    }
  } catch (e) {
    console.error('[Meta Campañas] Error general:', e.message);
  }
}

// ── Loop con await: los ciclos nunca se solapan ───────────────
async function loop() {
  console.log('[Meta Campañas] ✅ Procesador activo');
  while (true) {
    await procesarCampanas();
    await esperar(10000);
  }
}

if (require.main === module) loop();

module.exports = { procesarCampanas };
