'use strict';

/**
 * Correos del monitor del servidor (alerta crítica, alerta resuelta y prueba).
 * Usa el mismo SMTP que el sistema de pagos (saas_config.smtp_*).
 */
const nodemailer = require('nodemailer');
const { masterQuery } = require('../config/masterDB');
const logger = require('../config/logger');

// Se guarda la última config SMTP leída: si MySQL se cae, igual se puede avisar
let smtpCache = null;

async function leerSmtp() {
  try {
    const filas = await masterQuery("SELECT clave, valor FROM saas_config WHERE clave LIKE 'smtp%' OR clave = 'empresa_nombre'");
    const cfg = Object.fromEntries(filas.map(f => [f.clave, f.valor]));
    if (cfg.smtp_user && cfg.smtp_pass) smtpCache = cfg;
  } catch {}
  return smtpCache;
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fechaLima(d = new Date()) {
  return d.toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const COLORES = {
  critico : { fuerte: '#b42318', suave: '#fdeceb', borde: '#f2c4bf', etiqueta: 'ALERTA CRÍTICA', icono: '🔴' },
  resuelta: { fuerte: '#1b7a3c', suave: '#e7f4eb', borde: '#bfe0ca', etiqueta: 'RESUELTO',       icono: '✅' },
  prueba  : { fuerte: '#1d5fc0', suave: '#e9f0fc', borde: '#c6d8f2', etiqueta: 'CORREO DE PRUEBA', icono: '🔔' },
};

/** Fila del resumen del servidor con un punto de color según el estado. */
function filaEstado(nombre, valor, nivel) {
  const punto = { ok: '#1b7a3c', aviso: '#c27803', critico: '#b42318' }[nivel] || '#9ca3af';
  return `<tr>
    <td style="padding:9px 0;border-bottom:1px solid #f0f0ec;font-size:14px;color:#454a54">
      <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${punto};margin-right:8px"></span>${esc(nombre)}
    </td>
    <td style="padding:9px 0;border-bottom:1px solid #f0f0ec;font-size:14px;color:#15171b;font-weight:600;text-align:right">${esc(valor)}</td>
  </tr>`;
}

function nivelPor(valor, limite, avisoDesde = 0.8) {
  if (valor == null || limite == null) return 'ok';
  if (valor >= limite) return 'critico';
  return valor >= limite * avisoDesde ? 'aviso' : 'ok';
}

/** Resumen del servidor en el momento del correo. */
function bloqueResumen(est, umbrales) {
  if (!est) return '';
  const m = est.memoria || {}, d = est.disco || {}, my = est.mysql || {};
  const caidas = (est.pm2 || []).filter(p => !p.modulo && p.estado !== 'online');
  const filas = [
    filaEstado('CPU', est.cpu_pct != null ? `${est.cpu_pct} %` : '—', nivelPor(est.cpu_pct, umbrales.cpu)),
    filaEstado('Carga (5 min)', est.carga ? `${est.carga[1]} de ${est.nucleos} núcleos` : '—', nivelPor(est.carga?.[1], est.nucleos)),
    filaEstado('RAM disponible', m.disponible_mb != null ? `${(m.disponible_mb / 1024).toFixed(1)} GB de ${(m.total_mb / 1024).toFixed(1)} GB (${m.usada_pct} % en uso)` : '—', nivelPor(m.usada_pct, umbrales.ram)),
    filaEstado('Swap', m.swap_total_mb ? `${m.swap_pct} % en uso` : 'Sin swap', m.swap_total_mb ? nivelPor(m.swap_pct, umbrales.swap) : 'aviso'),
    filaEstado('Disco', d.usado_pct != null ? `${d.usado_gb} GB de ${d.total_gb} GB (${d.usado_pct} %)` : '—', nivelPor(d.usado_pct, umbrales.disco)),
    filaEstado('Conexiones MySQL', my.conexiones != null ? `${my.conexiones} de ${my.max_conexiones}` : 'Sin datos', my.conexiones != null ? nivelPor(my.conexiones_pct, umbrales.conexiones) : 'critico'),
    filaEstado('Apps en PM2', est.pm2 ? (caidas.length ? `${caidas.length} detenida(s): ${caidas.map(c => c.nombre).join(', ')}` : 'Todas en línea') : 'Sin datos', caidas.length ? 'critico' : 'ok'),
  ];
  return `
    <p style="margin:28px 0 6px;font-size:12px;font-weight:700;letter-spacing:.08em;color:#6c717a">ESTADO GENERAL DEL SERVIDOR</p>
    <table width="100%" cellpadding="0" cellspacing="0">${filas.join('')}</table>`;
}

function plantilla({ tipo, titulo, servidor, explicacion, metrica, pasos, estado, umbrales, panelUrl, duracion }) {
  const c = COLORES[tipo];
  const caja = metrica ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;background:${c.suave};border:1px solid ${c.borde};border-radius:12px">
      <tr>
        <td style="padding:18px 20px">
          <div style="font-size:13px;color:#454a54">${esc(metrica.nombre)}</div>
          <div style="font-size:30px;font-weight:700;color:${c.fuerte};margin-top:2px;white-space:nowrap">${esc(metrica.valor)}</div>
        </td>
        ${metrica.limite ? `<td style="padding:18px 20px;text-align:right;vertical-align:bottom">
          <div style="font-size:12px;color:#6c717a">Límite configurado</div>
          <div style="font-size:16px;font-weight:600;color:#262a31">${esc(metrica.limite)}</div>
        </td>` : ''}
      </tr>
    </table>` : '';

  const listaPasos = pasos?.length ? `
    <p style="margin:26px 0 8px;font-size:12px;font-weight:700;letter-spacing:.08em;color:#6c717a">${tipo === 'resuelta' ? 'RECOMENDACIÓN' : 'QUÉ PUEDES HACER'}</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${pasos.map((p, i) => `<tr>
        <td style="width:28px;vertical-align:top;padding:6px 0">
          <span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:50%;background:${c.suave};color:${c.fuerte};font-size:12px;font-weight:700">${i + 1}</span>
        </td>
        <td style="padding:7px 0 7px 6px;font-size:14px;line-height:1.55;color:#262a31">${p}</td>
      </tr>`).join('')}
    </table>` : '';

  const boton = panelUrl ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:30px 0 6px"><tr><td align="center">
      <a href="${esc(panelUrl)}" style="display:inline-block;background:${c.fuerte};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 28px;border-radius:10px">Abrir panel del servidor</a>
    </td></tr></table>` : '';

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(titulo)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f1"><tr><td align="center" style="padding:28px 12px">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e2dc">
    <tr><td style="background:${c.fuerte};padding:22px 28px">
      <div style="font-size:12px;font-weight:700;letter-spacing:.1em;color:#ffffff;opacity:.85">${c.icono} ${c.etiqueta}</div>
      <div style="font-size:21px;font-weight:700;color:#ffffff;margin-top:6px;line-height:1.3">${esc(titulo)}</div>
    </td></tr>
    <tr><td style="padding:24px 28px 30px">
      <div style="font-size:13px;color:#6c717a">Servidor <b style="color:#262a31">${esc(servidor)}</b> · ${esc(fechaLima())} (hora de Lima)${duracion ? ` · duró ${esc(duracion)}` : ''}</div>
      <p style="margin:18px 0 0;font-size:15px;line-height:1.6;color:#262a31">${explicacion}</p>
      ${caja}
      ${listaPasos}
      ${bloqueResumen(estado, umbrales)}
      ${boton}
    </td></tr>
    <tr><td style="background:#f8f8f6;padding:16px 28px;border-top:1px solid #ecece7;font-size:12px;line-height:1.55;color:#6c717a">
      Este aviso lo envía el monitor del servidor de VetNetcodip. Los límites y el correo de destino se cambian en el panel admin, sección <b>Servidor</b>.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

/** Texto plano para clientes de correo sin HTML. */
function textoPlano({ titulo, servidor, explicacionTxt, metrica, pasosTxt, panelUrl }) {
  return [
    titulo, `Servidor: ${servidor} · ${fechaLima()} (hora de Lima)`, '',
    explicacionTxt,
    metrica ? `\n${metrica.nombre}: ${metrica.valor}${metrica.limite ? ` (límite: ${metrica.limite})` : ''}` : '',
    pasosTxt?.length ? '\nQué puedes hacer:\n' + pasosTxt.map((p, i) => `${i + 1}. ${p}`).join('\n') : '',
    panelUrl ? `\nPanel: ${panelUrl}` : '',
  ].join('\n');
}

const sinHtml = s => String(s || '').replace(/<[^>]+>/g, '');

/**
 * Envía el correo. datos: { tipo, asunto, titulo, servidor, explicacion, metrica, pasos,
 * estado, umbrales, panelUrl, duracion, para }
 */
async function enviar(datos) {
  const smtp = await leerSmtp();
  if (!smtp) {
    const msg = 'El SMTP no está configurado: faltan smtp_user y smtp_pass en saas_config.';
    await masterQuery(
      'INSERT INTO saas_emails_log (tenant_id, tipo, destinatario, asunto, estado, error) VALUES (NULL, ?, ?, ?, ?, ?)',
      ['monitor_servidor', datos.para, datos.asunto.slice(0, 255), 'fallido', msg]
    ).catch(() => {});
    throw new Error(msg);
  }
  const transporter = nodemailer.createTransport({
    host: smtp.smtp_host || 'smtp.gmail.com',
    port: parseInt(smtp.smtp_port, 10) || 587,
    secure: parseInt(smtp.smtp_port, 10) === 465,
    auth: { user: smtp.smtp_user, pass: smtp.smtp_pass },
  });
  const html = plantilla(datos);
  const text = textoPlano({ ...datos, explicacionTxt: sinHtml(datos.explicacion), pasosTxt: (datos.pasos || []).map(sinHtml) });
  try {
    await transporter.sendMail({
      from: `"Monitor VetNetcodip" <${smtp.smtp_from || smtp.smtp_user}>`,
      to: datos.para, subject: datos.asunto, html, text,
      priority: datos.tipo === 'critico' ? 'high' : 'normal',
    });
    await masterQuery(
      'INSERT INTO saas_emails_log (tenant_id, tipo, destinatario, asunto, estado) VALUES (NULL, ?, ?, ?, ?)',
      ['monitor_servidor', datos.para, datos.asunto.slice(0, 255), 'enviado']
    ).catch(() => {});
  } catch (e) {
    logger.error(`[monitor] No se pudo enviar el correo: ${e.message}`);
    await masterQuery(
      'INSERT INTO saas_emails_log (tenant_id, tipo, destinatario, asunto, estado, error) VALUES (NULL, ?, ?, ?, ?, ?)',
      ['monitor_servidor', datos.para, datos.asunto.slice(0, 255), 'fallido', e.message]
    ).catch(() => {});
    throw e;
  }
}

module.exports = { enviar, plantilla };
