'use strict';

const { Router }      = require('express');
const { masterQuery } = require('../config/masterDB');
const srv     = require('../services/servidor.service');
const monitor = require('../jobs/servidor.monitor');
const router  = Router();

// Las tablas se crean al iniciar el monitor; si está apagado (desarrollo), al primer uso
let tablasListas = false;
router.use(async (_req, res, next) => {
  if (tablasListas) return next();
  try { await monitor.asegurarTablas(); tablasListas = true; next(); }
  catch (e) { res.status(500).json({ success: false, message: 'No se pudieron preparar las tablas del monitor: ' + e.message }); }
});

const quien = req => req.adminUser?.nombre || `admin #${req.adminUser?.id ?? '?'}`;

// GET /admin/api/servidor/estado — foto actual completa
router.get('/estado', async (_req, res) => {
  try {
    const data = await srv.estadoCompleto();
    const alertas = await masterQuery(
      "SELECT id, codigo, titulo, detalle, created_at FROM servidor_eventos WHERE tipo='alerta' AND estado='activa' ORDER BY created_at DESC"
    );
    res.json({
      success: true,
      data: { ...data, alertas, umbrales: monitor.umbrales(), monitor_encendido: monitor.monitorEncendido(), acciones: srv.ACCIONES_PERMITIDAS },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /admin/api/servidor/historial?rango=1h|24h|7d|30d — series para las gráficas
const RANGOS = { '1h': [1, 60], '6h': [6, 300], '24h': [24, 600], '7d': [168, 3600], '30d': [720, 21600] };
router.get('/historial', async (req, res) => {
  try {
    const [horas, bucket] = RANGOS[req.query.rango] || RANGOS['24h'];
    const filas = await masterQuery(
      `SELECT DATE_FORMAT(FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(fecha) / ${bucket}) * ${bucket}), '%Y-%m-%d %H:%i:%s') AS t,
              ROUND(AVG(cpu_pct), 1)  AS cpu,      ROUND(MAX(cpu_pct), 1) AS cpu_max,
              ROUND(AVG(ram_pct), 1)  AS ram,      MIN(ram_disp_mb)       AS ram_disp_min,
              ROUND(AVG(swap_pct), 1) AS swap,     ROUND(MAX(disco_pct), 1) AS disco,
              ROUND(AVG(carga1), 2)   AS carga,    MAX(mysql_conn)        AS conexiones
       FROM servidor_metricas
       WHERE fecha >= NOW() - INTERVAL ${horas} HOUR
       GROUP BY t ORDER BY t`
    );
    // MySQL devuelve los DECIMAL como texto; las gráficas necesitan números
    const data = filas.map(f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, k === 't' || v == null ? v : Number(v)])));
    res.json({ success: true, data, meta: { rango: req.query.rango || '24h', bucket_s: bucket } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /admin/api/servidor/eventos?tipo=alerta|accion — historial de alertas y acciones
router.get('/eventos', async (req, res) => {
  try {
    const params = [];
    let where = 'WHERE 1=1';
    if (['alerta', 'accion'].includes(req.query.tipo)) { where += ' AND tipo = ?'; params.push(req.query.tipo); }
    const limite = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const filas = await masterQuery(
      `SELECT id, tipo, nivel, codigo, titulo, detalle, estado, correo_enviado, admin,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              DATE_FORMAT(resuelta_at, '%Y-%m-%d %H:%i:%s') AS resuelta_at
       FROM servidor_eventos ${where} ORDER BY id DESC LIMIT ${limite}`, params
    );
    res.json({ success: true, data: filas });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /admin/api/servidor/config
router.get('/config', async (_req, res) => {
  try { res.json({ success: true, data: await monitor.leerConfig() }); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /admin/api/servidor/config
router.put('/config', async (req, res) => {
  try {
    const b = req.body || {};
    const cambios = {};
    const pct = (clave, min, max) => {
      if (b[clave] === undefined) return;
      const n = Number(b[clave]);
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`El valor de ${clave.replace('monitor_', '')} debe estar entre ${min} y ${max}.`);
      cambios[clave] = String(Math.round(n));
    };
    pct('monitor_cpu_pct', 50, 100); pct('monitor_ram_pct', 50, 99); pct('monitor_swap_pct', 10, 100);
    pct('monitor_disco_pct', 50, 99); pct('monitor_conexiones_pct', 50, 100);
    if (b.monitor_activo !== undefined) cambios.monitor_activo = b.monitor_activo ? '1' : '0';
    if (b.monitor_email !== undefined) {
      const email = String(b.monitor_email).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('El correo de alertas no es válido.');
      cambios.monitor_email = email;
    }
    if (b.monitor_panel_url !== undefined) {
      const url = String(b.monitor_panel_url).trim();
      if (url && !/^https?:\/\/\S+$/.test(url)) throw new Error('La dirección del panel no es válida.');
      cambios.monitor_panel_url = url;
    }
    for (const [clave, valor] of Object.entries(cambios)) {
      await masterQuery('UPDATE saas_config SET valor = ? WHERE clave = ?', [valor, clave]);
    }
    res.json({ success: true, data: await monitor.leerConfig(), message: 'Configuración guardada.' });
  } catch (e) { res.status(422).json({ success: false, message: e.message }); }
});

// POST /admin/api/servidor/acciones/:accion — acciones permitidas (lista cerrada)
const NOMBRE_ACCION = {
  pm2_reiniciar: 'Reiniciar app', pm2_vaciar_logs: 'Vaciar logs', pm2_reiniciar_contador: 'Contador de reinicios a cero',
  limpiar_journal: 'Recortar logs del sistema', cerrar_vscode: 'Cerrar VS Code', recargar_nginx: 'Recargar Nginx',
};
router.post('/acciones/:accion', async (req, res) => {
  const { accion } = req.params;
  if (!srv.ACCIONES_PERMITIDAS.includes(accion)) return res.status(404).json({ success: false, message: 'Acción no permitida.' });
  const nombre = req.body?.nombre ? String(req.body.nombre) : undefined;
  const titulo = `${NOMBRE_ACCION[accion] || accion}${nombre ? ` · ${nombre}` : ''}`;
  try {
    const mensaje = await srv.ejecutarAccion(accion, { nombre });
    await masterQuery(
      "INSERT INTO servidor_eventos (tipo, nivel, codigo, titulo, detalle, estado, admin, created_at) VALUES ('accion','info',?,?,?,'ok',?,NOW())",
      [accion, titulo.slice(0, 200), mensaje, quien(req)]
    ).catch(() => {});
    res.json({ success: true, message: mensaje });
  } catch (e) {
    await masterQuery(
      "INSERT INTO servidor_eventos (tipo, nivel, codigo, titulo, detalle, estado, admin, created_at) VALUES ('accion','aviso',?,?,?,'error',?,NOW())",
      [accion, titulo.slice(0, 200), e.message, quien(req)]
    ).catch(() => {});
    res.status(422).json({ success: false, message: e.message });
  }
});

// GET /admin/api/servidor/smtp — cuenta de envío de correos (la contraseña nunca se devuelve)
router.get('/smtp', async (_req, res) => {
  try {
    const filas = await masterQuery("SELECT clave, valor FROM saas_config WHERE clave LIKE 'smtp\\_%'");
    const c = Object.fromEntries(filas.map(f => [f.clave, f.valor]));
    res.json({ success: true, data: {
      smtp_host: c.smtp_host || 'smtp.gmail.com', smtp_port: c.smtp_port || '587',
      smtp_user: c.smtp_user || '', smtp_from: c.smtp_from || '', pass_configurada: !!c.smtp_pass,
    } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /admin/api/servidor/smtp — la contraseña solo se cambia si viene con valor
router.put('/smtp', async (req, res) => {
  try {
    const b = req.body || {};
    const host = String(b.smtp_host || '').trim();
    const port = parseInt(b.smtp_port, 10);
    const user = String(b.smtp_user || '').trim();
    const from = String(b.smtp_from || '').trim() || user;
    const pass = String(b.smtp_pass || '').replace(/\s+/g, '');
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('El servidor SMTP no es válido.');
    if (![25, 465, 587, 2525].includes(port)) throw new Error('El puerto debe ser 587, 465, 25 o 2525.');
    if (!email.test(user)) throw new Error('El usuario debe ser un correo válido.');
    if (!email.test(from)) throw new Error('El remitente debe ser un correo válido.');
    const valores = { smtp_host: host, smtp_port: String(port), smtp_user: user, smtp_from: from };
    if (pass) valores.smtp_pass = pass;
    for (const [clave, valor] of Object.entries(valores)) {
      await masterQuery(
        'INSERT INTO saas_config (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [clave, valor]
      );
    }
    const [p] = await masterQuery("SELECT valor <> '' AS ok FROM saas_config WHERE clave = 'smtp_pass'");
    await masterQuery(
      "INSERT INTO servidor_eventos (tipo, nivel, codigo, titulo, detalle, estado, admin, created_at) VALUES ('accion','info','smtp','Correo de envío actualizado',?,'ok',?,NOW())",
      [`${user} vía ${host}:${port}${pass ? ' · contraseña cambiada' : ''}`, quien(req)]
    ).catch(() => {});
    res.json({ success: true, message: 'Correo de envío guardado.', data: { pass_configurada: !!p?.ok } });
  } catch (e) { res.status(422).json({ success: false, message: e.message }); }
});

// POST /admin/api/servidor/probar-correo — envía un correo de prueba con el estado actual
router.post('/probar-correo', async (_req, res) => {
  try {
    await monitor.leerConfig();
    const estado = await srv.lecturaBasica();
    await monitor.enviarSiActivo({
      tipo: 'prueba',
      asunto: '🔔 [VetNetcodip] Correo de prueba del monitor del servidor',
      titulo: 'Las alertas del servidor llegan a este correo',
      explicacion: 'Este es un correo de prueba. Cuando el servidor tenga un problema crítico (CPU, RAM, disco, MySQL o una app caída) recibirás un aviso como este, con lo que está pasando y qué hacer. Cuando se normalice, te llegará otro avisando que se resolvió.',
      pasos: ['Agrega la dirección del remitente a tus contactos para que las alertas no lleguen a spam.'],
      estado,
    }, { lanzar: true });
    res.json({ success: true, message: 'Correo de prueba enviado.' });
  } catch (e) { res.status(422).json({ success: false, message: e.message }); }
});

module.exports = router;
