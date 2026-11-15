'use strict';

/**
 * Monitor del servidor: cada minuto guarda una muestra (CPU, RAM, swap, disco,
 * conexiones MySQL) y revisa las alertas críticas. Cuando una alerta empieza o se
 * resuelve, la registra en servidor_eventos y envía un correo.
 *
 * Se activa solo en Linux (el VPS). Para forzarlo: MONITOR_SERVIDOR=on · apagarlo: off.
 */
const os = require('os');
const { masterQuery } = require('../config/masterDB');
const logger = require('../config/logger');
const srv = require('../services/servidor.service');
const correo = require('../services/servidor.correo');

const INTERVALO_MS   = 60 * 1000;
const RETENCION_DIAS = 30;

const CONFIG_DEFECTO = {
  monitor_activo        : ['1',  'Monitor del servidor: 1 = encendido, 0 = apagado'],
  monitor_email         : ['ccristhiand@gmail.com', 'Correo que recibe las alertas críticas del servidor'],
  monitor_cpu_pct       : ['90', 'Alerta si la CPU pasa este % durante 5 minutos'],
  monitor_ram_pct       : ['90', 'Alerta si la RAM en uso pasa este % durante 3 minutos'],
  monitor_swap_pct      : ['60', 'Alerta si el swap en uso pasa este %'],
  monitor_disco_pct     : ['90', 'Alerta si el disco usado pasa este %'],
  monitor_conexiones_pct: ['85', 'Alerta si las conexiones MySQL pasan este % del máximo'],
  monitor_panel_url     : ['',   'Dirección del panel del servidor (botón de los correos)'],
};

let config = Object.fromEntries(Object.entries(CONFIG_DEFECTO).map(([k, [v]]) => [k, v]));
let timer = null;
let cpuPrevio = null;
let ultimaPurga = 0;

// Estado de cada alerta: cuántas muestras seguidas la cumplen / no la cumplen
const seguidos = new Map();
const limpios  = new Map();
// Alertas abiertas: codigo -> { id, desde, titulo }
const activas  = new Map();
// Historial de reinicios por app de PM2: nombre -> [{ t, reinicios }]
const historialReinicios = new Map();

async function asegurarTablas() {
  await masterQuery(`CREATE TABLE IF NOT EXISTS servidor_metricas (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    fecha       DATETIME      NOT NULL,
    cpu_pct     DECIMAL(5,1)  NULL,
    carga1      DECIMAL(6,2)  NULL,
    ram_pct     DECIMAL(5,1)  NULL,
    ram_disp_mb INT UNSIGNED  NULL,
    swap_pct    DECIMAL(5,1)  NULL,
    disco_pct   DECIMAL(5,1)  NULL,
    mysql_conn  SMALLINT UNSIGNED NULL,
    INDEX idx_fecha (fecha)
  ) ENGINE=InnoDB`);
  await masterQuery(`CREATE TABLE IF NOT EXISTS servidor_eventos (
    id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tipo           ENUM('alerta','accion') NOT NULL,
    nivel          ENUM('info','aviso','critico') NOT NULL DEFAULT 'info',
    codigo         VARCHAR(80)  NOT NULL,
    titulo         VARCHAR(200) NOT NULL,
    detalle        TEXT         NULL,
    estado         ENUM('activa','resuelta','ok','error') NOT NULL,
    correo_enviado TINYINT(1)   NOT NULL DEFAULT 0,
    admin          VARCHAR(150) NULL,
    created_at     DATETIME     NOT NULL,
    resuelta_at    DATETIME     NULL,
    INDEX idx_tipo_estado (tipo, estado),
    INDEX idx_created (created_at)
  ) ENGINE=InnoDB`);
  for (const [clave, [valor, desc]] of Object.entries(CONFIG_DEFECTO)) {
    await masterQuery('INSERT IGNORE INTO saas_config (clave, valor, descripcion) VALUES (?,?,?)', [clave, valor, desc]);
  }
}

async function leerConfig() {
  try {
    const filas = await masterQuery("SELECT clave, valor FROM saas_config WHERE clave LIKE 'monitor\\_%'");
    filas.forEach(f => { config[f.clave] = f.valor; });
  } catch {}
  return config;
}

function umbrales() {
  return {
    cpu       : Number(config.monitor_cpu_pct) || 90,
    ram       : Number(config.monitor_ram_pct) || 90,
    swap      : Number(config.monitor_swap_pct) || 60,
    disco     : Number(config.monitor_disco_pct) || 90,
    conexiones: Number(config.monitor_conexiones_pct) || 85,
  };
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function duracionTexto(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

/**
 * Revisa la lectura y devuelve las condiciones críticas presentes.
 * Cada una: { codigo, muestras (seguidas para disparar), titulo, explicacion, metrica, pasos }
 */
function detectar(est) {
  const u = umbrales();
  const out = [];
  const m = est.memoria || {}, d = est.disco || {}, my = est.mysql || {};

  if (est.cpu_pct != null && est.cpu_pct >= u.cpu) out.push({
    codigo: 'cpu', muestras: 5,
    titulo: `CPU al ${est.cpu_pct} % durante 5 minutos`,
    explicacion: `El procesador lleva al menos 5 minutos por encima del <b>${u.cpu} %</b>. Las clínicas pueden notar la app lenta o con demoras al guardar.`,
    metrica: { nombre: 'Uso de CPU', valor: `${est.cpu_pct} %`, limite: `${u.cpu} %` },
    pasos: [
      'En el panel, sección <b>Servidor</b>, revisa la tabla de <b>Apps en PM2</b> y busca cuál tiene la CPU más alta.',
      'Si es una app con un proceso atascado, reiníciala desde el mismo panel con el botón <b>Reiniciar</b>.',
      'Si aparecen procesos de <b>VS Code</b>, ciérralos con <b>Cerrar VS Code</b>: consumen CPU y RAM.',
      'Si se repite a diario a la misma hora, revisa las tareas programadas (backups, campañas de WhatsApp).',
    ],
  });

  if (m.usada_pct != null && m.usada_pct >= u.ram) out.push({
    codigo: 'ram', muestras: 3,
    titulo: `RAM al ${m.usada_pct} % (quedan ${m.disponible_mb} MB)`,
    explicacion: `La memoria en uso pasó el <b>${u.ram} %</b> y quedan solo <b>${m.disponible_mb} MB</b> disponibles. Si se acaba, Linux empieza a usar el swap (más lento) y, en el peor caso, cierra el proceso que más memoria usa, normalmente <b>MySQL</b>.`,
    metrica: { nombre: 'RAM en uso', valor: `${m.usada_pct} %`, limite: `${u.ram} %` },
    pasos: [
      'En el panel, revisa <b>Procesos que más memoria usan</b> para ver quién la está ocupando.',
      'Cierra los procesos de <b>VS Code</b> si están abiertos (suelen ocupar cerca de 1 GB).',
      'Reinicia la app de PM2 que haya crecido de forma anormal.',
      'Si pasa seguido aunque todo esté normal, el VPS necesita más RAM.',
    ],
  });

  if (m.swap_total_mb > 0 && m.swap_pct >= u.swap) out.push({
    codigo: 'swap', muestras: 3,
    titulo: `Swap al ${m.swap_pct} %: falta memoria RAM`,
    explicacion: `El servidor está usando <b>${m.swap_usada_mb} MB</b> de swap, más del <b>${u.swap} %</b>. El swap es memoria de reserva en el disco: si se usa tanto, la RAM no alcanza y todo se vuelve más lento.`,
    metrica: { nombre: 'Swap en uso', valor: `${m.swap_pct} %`, limite: `${u.swap} %` },
    pasos: [
      'Revisa qué proceso está usando más memoria en el panel.',
      'Reinicia la app que tenga la memoria anormalmente alta: al reiniciar, libera lo que tenía en swap.',
      'Si se repite, considera ampliar la RAM del VPS.',
    ],
  });

  if (d.usado_pct != null && d.usado_pct >= u.disco) out.push({
    codigo: 'disco', muestras: 1,
    titulo: `Disco al ${d.usado_pct} % (quedan ${d.libre_gb} GB)`,
    explicacion: `El disco pasó el <b>${u.disco} %</b>. Si se llena, MySQL deja de guardar datos y las clínicas no podrán registrar citas, historias ni ventas.`,
    metrica: { nombre: 'Disco usado', valor: `${d.usado_pct} %`, limite: `${u.disco} %` },
    pasos: [
      'En el panel, usa <b>Recortar logs del sistema</b> y <b>Vaciar logs</b> de las apps de PM2.',
      'Revisa si hay backups locales antiguos o archivos .zip olvidados en el servidor.',
      'Si el espacio sigue bajo, amplía el disco del VPS.',
    ],
  });

  if (my.error || (my.conexiones_pct != null && my.conexiones_pct >= u.conexiones)) out.push({
    codigo: 'mysql_conexiones', muestras: my.error ? 2 : 3,
    titulo: my.error ? 'No se puede consultar MySQL' : `MySQL con ${my.conexiones} de ${my.max_conexiones} conexiones`,
    explicacion: my.error
      ? `El monitor no pudo consultar la base de datos: <b>${esc(my.error)}</b>. Las clínicas probablemente no pueden usar el sistema.`
      : `MySQL está usando el <b>${my.conexiones_pct} %</b> de sus conexiones. Al llegar al máximo, las nuevas peticiones fallan con “Too many connections”.`,
    metrica: my.error ? null : { nombre: 'Conexiones MySQL', valor: `${my.conexiones} / ${my.max_conexiones}`, limite: `${u.conexiones} %` },
    pasos: my.error ? [
      'Entra al servidor y revisa MySQL con <b>systemctl status mysql</b>.',
      'Si está detenido, levántalo con <b>systemctl start mysql</b> y revisa el log en <b>/var/log/mysql/error.log</b>.',
    ] : [
      'Reinicia la app que tenga más conexiones abiertas (normalmente vetclinic-api).',
      'Si pasa seguido, sube <b>max_connections</b> en /etc/mysql/mysql.conf.d/zz-ligero.cnf.',
    ],
  });

  for (const [nombre, estado] of Object.entries(est.servicios || {})) {
    if (estado && estado !== 'active') out.push({
      codigo: `servicio:${nombre}`, muestras: 2,
      titulo: `${nombre === 'nginx' ? 'Nginx' : 'MySQL'} no está activo`,
      explicacion: nombre === 'nginx'
        ? 'Nginx es la puerta de entrada de todas las clínicas. Si no está activo, <b>nadie puede abrir el sistema</b>.'
        : 'MySQL es la base de datos de todas las clínicas. Si no está activo, <b>el sistema no puede leer ni guardar nada</b>.',
      metrica: { nombre: `Estado de ${nombre}`, valor: estado },
      pasos: [
        `Entra al servidor y ejecuta <b>systemctl status ${nombre}</b> para ver el error.`,
        `Intenta levantarlo con <b>systemctl start ${nombre}</b>.`,
        nombre === 'nginx' ? 'Si no arranca, revisa la configuración con <b>nginx -t</b>.' : 'Si no arranca, revisa <b>/var/log/mysql/error.log</b>.',
      ],
    });
  }

  const ahora = Date.now();
  for (const app of (est.pm2 || []).filter(a => !a.modulo)) {
    if (app.estado !== 'online' && app.estado !== 'launching') out.push({
      codigo: `pm2:${app.nombre}:caida`, muestras: 2,
      titulo: `La app ${app.nombre} está detenida`,
      explicacion: `PM2 muestra la app <b>${esc(app.nombre)}</b> en estado <b>${esc(app.estado)}</b>. Mientras siga así, la función que atiende no está disponible.`,
      metrica: { nombre: 'Estado en PM2', valor: app.estado },
      pasos: [
        `Reiníciala desde el panel (<b>Apps en PM2 → Reiniciar</b>).`,
        `Si vuelve a caerse, revisa el error en el servidor con <b>pm2 logs ${esc(app.nombre)} --err --lines 80</b>.`,
      ],
    });

    // Bucle de caídas: 3 o más reinicios en 15 minutos
    const hist = (historialReinicios.get(app.nombre) || []).filter(h => ahora - h.t <= 15 * 60000);
    hist.push({ t: ahora, reinicios: app.reinicios });
    historialReinicios.set(app.nombre, hist);
    const nuevos = app.reinicios - Math.min(...hist.map(h => h.reinicios));
    if (nuevos >= 3) out.push({
      codigo: `pm2:${app.nombre}:reinicios`, muestras: 1,
      titulo: `${app.nombre} se reinició ${nuevos} veces en 15 minutos`,
      explicacion: `La app <b>${esc(app.nombre)}</b> se está cayendo y PM2 la vuelve a levantar una y otra vez. Las clínicas pueden ver errores intermitentes.`,
      metrica: { nombre: 'Reinicios en 15 min', valor: String(nuevos), limite: '3' },
      pasos: [
        `Revisa el error en el servidor con <b>pm2 logs ${esc(app.nombre)} --err --lines 80</b>.`,
        'Si coincidió con un despliegue, revisa los últimos cambios subidos.',
      ],
    });
  }
  return out;
}

async function abrirAlerta(cond, est) {
  let id = null;
  try {
    const r = await masterQuery(
      `INSERT INTO servidor_eventos (tipo, nivel, codigo, titulo, detalle, estado, created_at)
       VALUES ('alerta','critico',?,?,?,'activa',NOW())`,
      [cond.codigo, cond.titulo.slice(0, 200), cond.explicacion.replace(/<[^>]+>/g, '')]
    );
    id = r.insertId;
  } catch (e) { logger.warn(`[monitor] No se pudo registrar la alerta: ${e.message}`); }
  activas.set(cond.codigo, { id, desde: Date.now(), titulo: cond.titulo, metrica: cond.metrica });
  logger.warn(`[monitor] ALERTA ${cond.codigo}: ${cond.titulo}`);

  const enviado = await enviarSiActivo({
    tipo: 'critico',
    asunto: `🔴 [VetNetcodip] Crítico: ${cond.titulo}`,
    titulo: cond.titulo, explicacion: cond.explicacion, metrica: cond.metrica, pasos: cond.pasos, estado: est,
  });
  if (id && enviado) await masterQuery('UPDATE servidor_eventos SET correo_enviado = 1 WHERE id = ?', [id]).catch(() => {});
}

async function cerrarAlerta(codigo, est) {
  const a = activas.get(codigo);
  activas.delete(codigo);
  if (a?.id) await masterQuery("UPDATE servidor_eventos SET estado='resuelta', resuelta_at=NOW() WHERE id = ?", [a.id]).catch(() => {});
  logger.info(`[monitor] Resuelta ${codigo}`);
  const titulo = `Se normalizó: ${a?.titulo || codigo}`;
  await enviarSiActivo({
    tipo: 'resuelta',
    asunto: `✅ [VetNetcodip] Resuelto: ${a?.titulo || codigo}`,
    titulo,
    explicacion: 'La condición que generó la alerta ya no se cumple y el servidor volvió a valores normales. No hace falta que hagas nada más.',
    duracion: a?.desde ? duracionTexto(Date.now() - a.desde) : null,
    pasos: ['Si esta alerta se repite seguido, revisa el historial de eventos en el panel para encontrar el patrón (hora, app o proceso).'],
    estado: est,
  });
}

async function enviarSiActivo(datos) {
  if (!config.monitor_email) return false;
  try {
    await correo.enviar({
      ...datos, para: config.monitor_email, servidor: os.hostname(),
      umbrales: umbrales(), panelUrl: config.monitor_panel_url || null,
    });
    return true;
  } catch { return false; }
}

async function revisarAlertas(est) {
  const presentes = new Map(detectar(est).map(c => [c.codigo, c]));
  for (const [codigo, cond] of presentes) {
    seguidos.set(codigo, (seguidos.get(codigo) || 0) + 1);
    limpios.delete(codigo);
    if (!activas.has(codigo) && seguidos.get(codigo) >= cond.muestras) await abrirAlerta(cond, est);
  }
  for (const codigo of [...seguidos.keys()]) if (!presentes.has(codigo)) seguidos.delete(codigo);
  // Se da por resuelta tras 3 muestras seguidas sin la condición (evita correos por altibajos)
  for (const codigo of [...activas.keys()]) {
    if (presentes.has(codigo)) continue;
    limpios.set(codigo, (limpios.get(codigo) || 0) + 1);
    if (limpios.get(codigo) >= 3) { limpios.delete(codigo); await cerrarAlerta(codigo, est); }
  }
}

async function guardarMuestra(est) {
  await masterQuery(
    `INSERT INTO servidor_metricas (fecha, cpu_pct, carga1, ram_pct, ram_disp_mb, swap_pct, disco_pct, mysql_conn)
     VALUES (NOW(),?,?,?,?,?,?,?)`,
    [est.cpu_pct, est.carga?.[0] ?? null, est.memoria?.usada_pct ?? null, est.memoria?.disponible_mb ?? null,
     est.memoria?.swap_pct ?? null, est.disco?.usado_pct ?? null, est.mysql?.conexiones ?? null]
  );
  if (Date.now() - ultimaPurga > 6 * 3600000) {
    ultimaPurga = Date.now();
    await masterQuery(`DELETE FROM servidor_metricas WHERE fecha < NOW() - INTERVAL ${RETENCION_DIAS} DAY`);
    await masterQuery("DELETE FROM servidor_eventos WHERE created_at < NOW() - INTERVAL 180 DAY AND estado <> 'activa'");
  }
}

async function ciclo() {
  try {
    await leerConfig();
    const ahora = srv.tiemposCpu();
    const cpu = cpuPrevio ? srv.pctCpu(cpuPrevio, ahora) : await srv.medirCpu();
    cpuPrevio = ahora;
    const est = await srv.lecturaBasica(cpu);
    await guardarMuestra(est).catch(e => logger.warn(`[monitor] No se guardó la muestra: ${e.message}`));
    if (config.monitor_activo !== '0') await revisarAlertas(est);
  } catch (e) {
    logger.error(`[monitor] Error en el ciclo: ${e.message}`);
  }
}

async function iniciarMonitorServidor() {
  const modo = (process.env.MONITOR_SERVIDOR || '').toLowerCase();
  if (modo === 'off' || (!srv.ES_LINUX && modo !== 'on')) {
    logger.info('[monitor] Monitor del servidor desactivado en este entorno.');
    return;
  }
  try {
    await asegurarTablas();
    // Alertas que quedaron abiertas antes de un reinicio: no se vuelven a enviar
    const abiertas = await masterQuery("SELECT id, codigo, titulo, created_at FROM servidor_eventos WHERE tipo='alerta' AND estado='activa'");
    abiertas.forEach(a => activas.set(a.codigo, { id: a.id, desde: new Date(a.created_at).getTime(), titulo: a.titulo }));
  } catch (e) {
    logger.warn(`[monitor] No se pudieron preparar las tablas: ${e.message}`);
  }
  await ciclo();
  timer = setInterval(ciclo, INTERVALO_MS);
  logger.info('[monitor] ✅ Monitor del servidor iniciado (cada 60 s)');
}

function detenerMonitorServidor() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
  iniciarMonitorServidor, detenerMonitorServidor, asegurarTablas, leerConfig, umbrales,
  CONFIG_DEFECTO, enviarSiActivo, revisarAlertas,
  monitorEncendido: () => !!timer,
  alertasActivas: () => [...activas.entries()].map(([codigo, a]) => ({ codigo, ...a })),
};
