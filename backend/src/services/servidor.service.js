'use strict';

/**
 * Estado del VPS: CPU, memoria, swap, disco, procesos PM2, servicios y MySQL.
 * También ejecuta las acciones permitidas desde el panel admin (lista cerrada,
 * nunca comandos libres). Pensado para Linux; en otros sistemas devuelve lo que pueda.
 */
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { masterQuery } = require('../config/masterDB');

const ES_LINUX = process.platform === 'linux';
const PM2_BIN  = process.env.PM2_BIN || 'pm2';

function ejecutar(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, codigo: err?.code ?? 0, salida: String(stdout || ''), error: String(stderr || err?.message || '') });
    });
  });
}

const redondear = (n, d = 1) => (n == null || isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

// ── CPU: % de uso entre dos lecturas de os.cpus() ────────────────
function tiemposCpu() {
  return os.cpus().reduce((acc, c) => {
    const t = c.times;
    acc.ocupado += t.user + t.nice + t.sys + t.irq;
    acc.total   += t.user + t.nice + t.sys + t.irq + t.idle;
    return acc;
  }, { ocupado: 0, total: 0 });
}
function pctCpu(a, b) {
  const total = b.total - a.total;
  return total > 0 ? redondear(((b.ocupado - a.ocupado) / total) * 100) : null;
}
async function medirCpu(ms = 1000) {
  const a = tiemposCpu();
  await new Promise(r => setTimeout(r, ms));
  return pctCpu(a, tiemposCpu());
}

// ── Memoria y swap (MemAvailable es lo que de verdad queda libre) ──
function leerMemoria() {
  let total = os.totalmem(), disponible = os.freemem(), swapTotal = 0, swapLibre = 0;
  if (ES_LINUX) {
    try {
      const info = {};
      fs.readFileSync('/proc/meminfo', 'utf8').split('\n').forEach(l => {
        const m = l.match(/^(\w+):\s+(\d+)/);
        if (m) info[m[1]] = parseInt(m[2], 10) * 1024;
      });
      total      = info.MemTotal     ?? total;
      disponible = info.MemAvailable ?? disponible;
      swapTotal  = info.SwapTotal    ?? 0;
      swapLibre  = info.SwapFree     ?? 0;
    } catch {}
  }
  const MB = 1048576;
  return {
    total_mb     : Math.round(total / MB),
    disponible_mb: Math.round(disponible / MB),
    usada_pct    : redondear((1 - disponible / total) * 100),
    swap_total_mb: Math.round(swapTotal / MB),
    swap_usada_mb: Math.round((swapTotal - swapLibre) / MB),
    swap_pct     : swapTotal > 0 ? redondear(((swapTotal - swapLibre) / swapTotal) * 100) : 0,
  };
}

function leerDisco(ruta = '/') {
  try {
    const s = fs.statfsSync(ES_LINUX ? ruta : path.parse(process.cwd()).root);
    const total = s.blocks * s.bsize, libre = s.bavail * s.bsize;
    const GB = 1073741824;
    return {
      total_gb : redondear(total / GB),
      usado_gb : redondear((total - libre) / GB),
      libre_gb : redondear(libre / GB),
      usado_pct: redondear(((total - libre) / total) * 100),
    };
  } catch { return null; }
}

// ── PM2 ───────────────────────────────────────────────────────────
async function listarPm2() {
  const r = await ejecutar(PM2_BIN, ['jlist']);
  if (!r.ok) return null;
  try {
    const inicio = r.salida.indexOf('[');
    return JSON.parse(r.salida.slice(inicio)).map(p => ({
      id       : p.pm_id,
      nombre   : p.name,
      estado   : p.pm2_env?.status,
      pid      : p.pid,
      cpu_pct  : p.monit?.cpu ?? 0,
      ram_mb   : Math.round((p.monit?.memory || 0) / 1048576),
      reinicios: p.pm2_env?.restart_time ?? 0,
      inestables: p.pm2_env?.unstable_restarts ?? 0,
      desde    : p.pm2_env?.pm_uptime || null,
      modulo   : !!p.pm2_env?.pmx_module,
    }));
  } catch { return null; }
}

async function estadoServicio(nombre) {
  if (!ES_LINUX) return null;
  const r = await ejecutar('systemctl', ['is-active', nombre], 5000);
  return r.salida.trim() || 'desconocido';
}

// ── MySQL ─────────────────────────────────────────────────────────
async function leerMysql() {
  try {
    const filas = await masterQuery(
      `SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Max_used_connections','Uptime','Questions','Slow_queries')`
    );
    const st = Object.fromEntries(filas.map(f => [f.Variable_name, Number(f.Value)]));
    const [cfg] = await masterQuery('SELECT @@max_connections AS max_con, @@performance_schema AS perf, ROUND(@@innodb_buffer_pool_size/1048576) AS buffer_mb');
    return {
      conexiones     : st.Threads_connected,
      max_usadas     : st.Max_used_connections,
      max_conexiones : Number(cfg.max_con),
      conexiones_pct : redondear((st.Threads_connected / Number(cfg.max_con)) * 100),
      consultas_total: st.Questions,
      lentas         : st.Slow_queries,
      uptime_s       : st.Uptime,
      performance_schema: Number(cfg.perf) === 1,
      buffer_mb      : Number(cfg.buffer_mb),
    };
  } catch (e) { return { error: e.message }; }
}

// ── Procesos que más memoria usan (+ VS Code olvidado) ───────────
async function procesosTop(limite = 8) {
  if (!ES_LINUX) return { top: [], vscode: { procesos: 0, ram_mb: 0 } };
  const r = await ejecutar('ps', ['-eo', 'pid=,rss=,etimes=,comm=,args=', '--sort=-rss'], 5000);
  const filas = r.salida.split('\n').filter(Boolean).map(l => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    return m && { pid: +m[1], ram_mb: Math.round(+m[2] / 1024), segundos: +m[3], nombre: m[4], comando: m[5].slice(0, 90) };
  }).filter(Boolean);
  const vs = filas.filter(p => /vscode-server/.test(p.comando) || /^code-/.test(p.nombre));
  return {
    top: filas.slice(0, limite),
    vscode: { procesos: vs.length, ram_mb: vs.reduce((s, p) => s + p.ram_mb, 0) },
  };
}

function tamanoCarpetaMb(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      total += f.isDirectory() ? tamanoCarpetaMb(p) * 1048576 : fs.statSync(p).size;
    }
  } catch {}
  return Math.round(total / 1048576);
}

async function leerLogs() {
  const pm2Logs = path.join(os.homedir(), '.pm2', 'logs');
  let journal_mb = null;
  if (ES_LINUX) {
    const r = await ejecutar('journalctl', ['--disk-usage'], 5000);
    const m = r.salida.match(/([\d.]+)([KMGT])/);
    if (m) journal_mb = Math.round(parseFloat(m[1]) * { K: 1 / 1024, M: 1, G: 1024, T: 1048576 }[m[2]]);
  }
  return { journal_mb, pm2_mb: tamanoCarpetaMb(pm2Logs) };
}

/** Lectura liviana para el muestreo periódico (sin ps ni du). */
async function lecturaBasica(cpuPct) {
  const [pm2, mysql] = await Promise.all([listarPm2(), leerMysql()]);
  return {
    cpu_pct: cpuPct ?? await medirCpu(),
    carga  : os.loadavg().map(n => redondear(n, 2)),
    nucleos: os.cpus().length,
    memoria: leerMemoria(),
    disco  : leerDisco(),
    pm2, mysql,
    servicios: { nginx: await estadoServicio('nginx'), mysql: await estadoServicio('mysql') },
  };
}

/** Foto completa para el panel. */
async function estadoCompleto() {
  const [base, procesos, logs] = await Promise.all([lecturaBasica(), procesosTop(), leerLogs()]);
  return {
    ...base,
    servidor: { host: os.hostname(), sistema: `${os.type()} ${os.release()}`, uptime_s: Math.round(os.uptime()), linux: ES_LINUX },
    procesos, logs,
    leido_en: new Date().toISOString(),
  };
}

// ── Acciones permitidas desde el panel ───────────────────────────
// Cada acción valida sus parámetros; no se aceptan comandos libres.
const ACCIONES = {
  async pm2_reiniciar({ nombre }) {
    const apps = await listarPm2();
    if (!apps?.some(a => a.nombre === nombre && !a.modulo)) throw new Error('Esa app no existe en PM2.');
    // Reiniciar la propia API corta esta petición: se responde primero y se reinicia después
    if (nombre === process.env.name) {
      setTimeout(() => ejecutar(PM2_BIN, ['restart', nombre]), 1500);
      return `Reiniciando ${nombre} en unos segundos…`;
    }
    const r = await ejecutar(PM2_BIN, ['restart', nombre], 30000);
    if (!r.ok) throw new Error(r.error || 'PM2 no pudo reiniciar la app.');
    return `${nombre} reiniciada.`;
  },
  async pm2_vaciar_logs({ nombre }) {
    const apps = await listarPm2();
    if (!apps?.some(a => a.nombre === nombre)) throw new Error('Esa app no existe en PM2.');
    const r = await ejecutar(PM2_BIN, ['flush', nombre]);
    if (!r.ok) throw new Error(r.error || 'No se pudieron vaciar los logs.');
    return `Logs de ${nombre} vaciados.`;
  },
  async pm2_reiniciar_contador({ nombre }) {
    const apps = await listarPm2();
    if (!apps?.some(a => a.nombre === nombre)) throw new Error('Esa app no existe en PM2.');
    const r = await ejecutar(PM2_BIN, ['reset', nombre]);
    if (!r.ok) throw new Error(r.error || 'No se pudo reiniciar el contador.');
    return `Contador de reinicios de ${nombre} en cero.`;
  },
  async limpiar_journal() {
    if (!ES_LINUX) throw new Error('Solo disponible en el servidor Linux.');
    const r = await ejecutar('journalctl', ['--vacuum-size=200M'], 60000);
    if (!r.ok) throw new Error(r.error || 'No se pudo recortar el journal.');
    const m = (r.salida + r.error).match(/freed ([\d.]+[KMG]?B?)/g);
    return `Journal recortado a 200 MB${m ? ` (${m.pop().replace('freed', 'liberado')})` : ''}.`;
  },
  async cerrar_vscode() {
    if (!ES_LINUX) throw new Error('Solo disponible en el servidor Linux.');
    const antes = (await procesosTop()).vscode;
    if (!antes.procesos) return 'No había procesos de VS Code.';
    await ejecutar('pkill', ['-f', 'vscode-server'], 10000);
    return `Cerrados ${antes.procesos} procesos de VS Code (${antes.ram_mb} MB).`;
  },
  async recargar_nginx() {
    if (!ES_LINUX) throw new Error('Solo disponible en el servidor Linux.');
    const prueba = await ejecutar('nginx', ['-t'], 15000);
    if (!prueba.ok) throw new Error('La configuración de Nginx tiene errores; no se recargó. ' + prueba.error.slice(0, 300));
    const r = await ejecutar('systemctl', ['reload', 'nginx'], 15000);
    if (!r.ok) throw new Error(r.error || 'No se pudo recargar Nginx.');
    return 'Nginx recargado (configuración verificada).';
  },
};

async function ejecutarAccion(accion, params = {}) {
  const fn = ACCIONES[accion];
  if (!fn) throw new Error('Acción no permitida.');
  return fn(params);
}

module.exports = {
  ES_LINUX, tiemposCpu, pctCpu, medirCpu, lecturaBasica, estadoCompleto,
  listarPm2, ejecutarAccion, ACCIONES_PERMITIDAS: Object.keys(ACCIONES),
};
