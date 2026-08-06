'use strict';

const nodemailer = require('nodemailer');
const { query, queryOne } = require('../db');

// ── Crear transporter ─────────────────────────────────────────
async function getTransporter() {
  const cfg = {};
  const rows = await query('SELECT clave, valor FROM saas_config WHERE clave LIKE \'smtp%\' OR clave = \'empresa_nombre\'');
  rows.forEach(r => { cfg[r.clave] = r.valor; });

  return nodemailer.createTransport({
    host  : cfg.smtp_host || 'smtp.gmail.com',
    port  : parseInt(cfg.smtp_port) || 587,
    secure: false,
    auth  : { user: cfg.smtp_user, pass: cfg.smtp_pass },
  });
}

// ── Log de email ──────────────────────────────────────────────
async function logEmail(tenantId, tipo, destinatario, asunto, estado, error = null) {
  try {
    await query(
      'INSERT INTO saas_emails_log (tenant_id, tipo, destinatario, asunto, estado, error) VALUES (?,?,?,?,?,?)',
      [tenantId || null, tipo, destinatario, asunto, estado, error]
    );
  } catch {}
}

// ── Template base ─────────────────────────────────────────────
function template(titulo, contenido, cta = null) {
  const btn = cta
    ? `<div style="text-align:center;margin:2rem 0">
         <a href="${cta.url}" style="background:#166534;color:#fff;padding:.85rem 2rem;
           border-radius:.75rem;text-decoration:none;font-weight:700;font-size:.95rem;
           display:inline-block">${cta.label}</a>
       </div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center" style="padding:2rem 1rem">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
    <!-- Header -->
    <tr><td style="background:linear-gradient(135deg,#166534,#14532d);padding:2rem;border-radius:1rem 1rem 0 0;text-align:center">
      <h1 style="color:#fff;margin:0;font-size:1.5rem">🐾 VetNetcodip</h1>
      <p style="color:#bbf7d0;margin:.25rem 0 0;font-size:.85rem">Sistema de Gestión Veterinaria</p>
    </td></tr>
    <!-- Content -->
    <tr><td style="background:#fff;padding:2rem;border-radius:0 0 1rem 1rem">
      <h2 style="color:#166534;margin-top:0">${titulo}</h2>
      ${contenido}
      ${btn}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:1.5rem 0"/>
      <p style="font-size:.75rem;color:#9ca3af;margin:0">
        VetNetcodip SaaS · Lima, Perú<br/>
        <a href="${process.env.PAGOS_URL || 'https://pagos.vetnetcodip.com'}" style="color:#166534">
          Acceder al portal de pagos
        </a>
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

function fDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-PE', { day:'2-digit', month:'long', year:'numeric' });
}

// ── Emails específicos ────────────────────────────────────────

async function enviarBienvenida({ email, nombre, clinica_nombre, password_temporal }) {
  const asunto = `🎉 Bienvenido a VetNetcodip — Acceso al portal de pagos`;
  const html   = template(
    `¡Bienvenido, ${nombre}!`,
    `<p>Tu clínica <strong>${clinica_nombre}</strong> ya está registrada en VetNetcodip.</p>
     <p>Usa el portal de pagos para gestionar tu suscripción, realizar pagos y descargar comprobantes.</p>
     <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:.75rem;padding:1rem;margin:1rem 0">
       <p style="margin:0"><strong>📧 Email:</strong> ${email}</p>
       <p style="margin:.5rem 0 0"><strong>🔐 Contraseña temporal:</strong> <code style="background:#e5e7eb;padding:.2rem .4rem;border-radius:.3rem">${password_temporal}</code></p>
     </div>
     <p style="font-size:.85rem;color:#6b7280">Te recomendamos cambiar tu contraseña al ingresar por primera vez.</p>`,
    { url: process.env.PAGOS_URL || 'https://pagos.vetnetcodip.com', label: '🚀 Acceder al portal' }
  );
  try {
    const t = await getTransporter();
    const cfg = await queryOne('SELECT valor FROM saas_config WHERE clave=\'smtp_from\'');
    await t.sendMail({ from: cfg?.valor || 'pagos@vetnetcodip.com', to: email, subject: asunto, html });
    await logEmail(null, 'bienvenida', email, asunto, 'enviado');
  } catch (e) {
    await logEmail(null, 'bienvenida', email, asunto, 'fallido', e.message);
  }
}

async function notificarAdminNuevoPago({ clinica_nombre, monto, metodo, numero_cobro }) {
  const cfg   = await query('SELECT clave, valor FROM saas_config WHERE clave IN (\'smtp_from\',\'smtp_user\')');
  const cfgMap = {};
  cfg.forEach(r => { cfgMap[r.clave] = r.valor; });
  const adminEmail = cfgMap.smtp_user || cfgMap.smtp_from;
  if (!adminEmail) return;

  const asunto = `🔔 Nuevo pago por validar — ${clinica_nombre}`;
  const html = template(
    '🔔 Nuevo pago recibido',
    `<p>La clínica <strong>${clinica_nombre}</strong> ha subido un comprobante de pago.</p>
     <table style="width:100%;border-collapse:collapse;margin:1rem 0">
       <tr style="background:#f9fafb"><td style="padding:.5rem .75rem;font-weight:600">Cobro</td><td style="padding:.5rem .75rem">${numero_cobro}</td></tr>
       <tr><td style="padding:.5rem .75rem;font-weight:600">Monto</td><td style="padding:.5rem .75rem">S/. ${parseFloat(monto).toFixed(2)}</td></tr>
       <tr style="background:#f9fafb"><td style="padding:.5rem .75rem;font-weight:600">Método</td><td style="padding:.5rem .75rem">${metodo}</td></tr>
     </table>
     <p>Ingresa al panel de admin para validar el comprobante.</p>`,
    { url: `${process.env.PAGOS_URL || 'https://pagos.vetnetcodip.com'}/admin`, label: '✅ Validar pago' }
  );
  try {
    const t = await getTransporter();
    await t.sendMail({ from: cfgMap.smtp_from || adminEmail, to: adminEmail, subject: asunto, html });
    await logEmail(null, 'admin_nuevo_pago', adminEmail, asunto, 'enviado');
  } catch (e) {
    await logEmail(null, 'admin_nuevo_pago', adminEmail, asunto, 'fallido', e.message);
  }
}

async function enviarAprobacion({ email, nombre, clinica_nombre, numero_comprobante, meses, monto, fecha_vencimiento, pdf_url }) {
  const asunto = `✅ Pago confirmado — ${clinica_nombre}`;
  const html = template(
    '✅ ¡Pago aprobado!',
    `<p>Hola <strong>${nombre}</strong>, tu pago ha sido validado y aprobado.</p>
     <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:.75rem;padding:1.25rem;margin:1rem 0">
       <p style="margin:0;font-size:1.1rem;font-weight:700;color:#166534">Tu sistema está activo</p>
       <table style="width:100%;margin:.75rem 0 0">
         <tr><td style="color:#6b7280;font-size:.85rem">Comprobante</td><td style="font-weight:700">${numero_comprobante}</td></tr>
         <tr><td style="color:#6b7280;font-size:.85rem">Meses pagados</td><td style="font-weight:700">${meses} ${meses === 1 ? 'mes' : 'meses'}</td></tr>
         <tr><td style="color:#6b7280;font-size:.85rem">Monto</td><td style="font-weight:700">S/. ${parseFloat(monto).toFixed(2)}</td></tr>
         <tr><td style="color:#6b7280;font-size:.85rem">Activo hasta</td><td style="font-weight:700;color:#166534">${fDate(fecha_vencimiento)}</td></tr>
       </table>
     </div>
     ${pdf_url ? `<p><a href="${pdf_url}" style="color:#166534;font-weight:600">📄 Descargar comprobante PDF</a></p>` : ''}`,
    { url: process.env.PAGOS_URL || 'https://pagos.vetnetcodip.com', label: '📊 Ver mi cuenta' }
  );
  try {
    const t = await getTransporter();
    const cfg = await queryOne('SELECT valor FROM saas_config WHERE clave=\'smtp_from\'');
    await t.sendMail({ from: cfg?.valor, to: email, subject: asunto, html });
    await logEmail(null, 'aprobacion', email, asunto, 'enviado');
  } catch (e) {
    await logEmail(null, 'aprobacion', email, asunto, 'fallido', e.message);
  }
}

async function enviarRechazo({ email, nombre, clinica_nombre, motivo, monto }) {
  const asunto = `⚠️ Comprobante no válido — Acción requerida`;
  const html = template(
    '⚠️ Comprobante rechazado',
    `<p>Hola <strong>${nombre}</strong>, lamentablemente no pudimos validar tu comprobante de pago.</p>
     <div style="background:#fff1f2;border:1px solid #fecdd3;border-radius:.75rem;padding:1rem;margin:1rem 0">
       <p style="margin:0;font-weight:700;color:#be123c">Motivo del rechazo:</p>
       <p style="margin:.5rem 0 0;color:#9f1239">${motivo}</p>
     </div>
     <p>Por favor sube un nuevo comprobante con la información correcta para que podamos validar tu pago de <strong>S/. ${parseFloat(monto).toFixed(2)}</strong>.</p>`,
    { url: process.env.PAGOS_URL || 'https://pagos.vetnetcodip.com', label: '📤 Volver a subir comprobante' }
  );
  try {
    const t = await getTransporter();
    const cfg = await queryOne('SELECT valor FROM saas_config WHERE clave=\'smtp_from\'');
    await t.sendMail({ from: cfg?.valor, to: email, subject: asunto, html });
    await logEmail(null, 'rechazo', email, asunto, 'enviado');
  } catch (e) {
    await logEmail(null, 'rechazo', email, asunto, 'fallido', e.message);
  }
}

async function enviarRecordatorio({ email, nombre, clinica_nombre, fecha_vencimiento, plan_nombre, monto, forzado = false }) {
  const dias = Math.ceil((new Date(fecha_vencimiento) - new Date()) / (1000 * 60 * 60 * 24));
  const urgente = dias <= 3;
  const asunto = urgente
    ? `🚨 ¡Quedan ${dias} días! — Renueva tu suscripción`
    : `⏰ Tu suscripción vence el ${fDate(fecha_vencimiento)}`;

  const html = template(
    urgente ? `🚨 ¡Renueva ahora!` : `⏰ Tu suscripción vence pronto`,
    `<p>Hola <strong>${nombre}</strong>, tu suscripción de <strong>${clinica_nombre}</strong> vence ${urgente ? `en <strong style="color:#be123c">${dias} días</strong>` : `el <strong>${fDate(fecha_vencimiento)}</strong>`}.</p>
     <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:.75rem;padding:1rem;margin:1rem 0">
       <p style="margin:0"><strong>Plan:</strong> ${plan_nombre}</p>
       <p style="margin:.5rem 0 0"><strong>Precio mensual:</strong> S/. ${parseFloat(monto).toFixed(2)}</p>
       <p style="margin:.5rem 0 0"><strong>Vence:</strong> ${fDate(fecha_vencimiento)}</p>
     </div>
     <p>Renueva antes de que venza para evitar la suspensión del servicio. ¡Recuerda que pagando más meses obtienes descuento!</p>`,
    { url: process.env.PAGOS_URL || 'https://pagos.vetnetcodip.com', label: '💳 Renovar suscripción' }
  );
  try {
    const t = await getTransporter();
    const cfg = await queryOne('SELECT valor FROM saas_config WHERE clave=\'smtp_from\'');
    await t.sendMail({ from: cfg?.valor, to: email, subject: asunto, html });
    await logEmail(null, forzado ? 'recordatorio_manual' : 'recordatorio_auto', email, asunto, 'enviado');
  } catch (e) {
    await logEmail(null, 'recordatorio', email, asunto, 'fallido', e.message);
  }
}

async function enviarRecuperacion(email, token) {
  const url    = `${process.env.PAGOS_URL || 'https://pagos.vetnetcodip.com'}/reset?token=${token}`;
  const asunto = '🔐 Recuperar contraseña — VetNetcodip';
  const html = template(
    '🔐 Recuperar contraseña',
    `<p>Recibimos una solicitud para restablecer tu contraseña.</p>
     <p>Este enlace es válido por <strong>2 horas</strong>.</p>
     <p>Si no solicitaste esto, puedes ignorar este mensaje.</p>`,
    { url, label: '🔑 Restablecer contraseña' }
  );
  try {
    const t = await getTransporter();
    const cfg = await queryOne('SELECT valor FROM saas_config WHERE clave=\'smtp_from\'');
    await t.sendMail({ from: cfg?.valor, to: email, subject: asunto, html });
    await logEmail(null, 'recuperacion', email, asunto, 'enviado');
  } catch (e) {
    await logEmail(null, 'recuperacion', email, asunto, 'fallido', e.message);
  }
}

module.exports = {
  enviarBienvenida, notificarAdminNuevoPago, enviarAprobacion,
  enviarRechazo, enviarRecordatorio, enviarRecuperacion,
};