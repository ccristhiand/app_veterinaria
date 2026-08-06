'use strict';

const { Router } = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { query, queryOne } = require('../db');

const router = Router();

const JWT_SECRET     = process.env.PAGOS_JWT_SECRET || 'pagos-secret-2026';
const JWT_EXPIRES_IN = '7d';

// ── POST /api/auth/login — cliente (clínica) ──────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(422).json({ success: false, message: 'Email y contraseña requeridos.' });

    const user = await queryOne(
      'SELECT * FROM saas_portal_usuarios WHERE email = ? AND activo = 1',
      [email.trim().toLowerCase()]
    );

    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ success: false, message: 'Credenciales incorrectas.' });

    // Cargar datos de la clínica y suscripción
    const tenant = await queryOne(
      `SELECT t.id, t.slug, tc.nombre_clinica, tc.color_primario, tc.logo_url,
              ss.id AS sus_id, ss.estado AS sus_estado, ss.fecha_vencimiento,
              ss.precio_acordado, sp.nombre AS plan_nombre, sp.codigo AS plan_codigo
       FROM tenants t
       JOIN tenant_config tc ON tc.tenant_id = t.id
       LEFT JOIN saas_suscripciones ss ON ss.tenant_id = t.id
       LEFT JOIN saas_planes sp ON sp.id = ss.plan_id
       WHERE t.id = ?`,
      [user.tenant_id]
    );

    await query('UPDATE saas_portal_usuarios SET ultimo_acceso=NOW() WHERE id=?', [user.id]);

    const token = jwt.sign(
      { id: user.id, tenant_id: user.tenant_id, tipo: 'cliente' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    return res.json({
      success: true,
      token,
      user: {
        id             : user.id,
        nombre         : user.nombre,
        email          : user.email,
        tenant_id      : user.tenant_id,
        clinica_nombre : tenant?.nombre_clinica || '',
        clinica_slug   : tenant?.slug || '',
        logo_url       : tenant?.logo_url || null,
        color_primario : tenant?.color_primario || '#166534',
        plan_nombre    : tenant?.plan_nombre || '',
        plan_codigo    : tenant?.plan_codigo || '',
        sus_estado     : tenant?.sus_estado || 'activa',
        fecha_vencimiento: tenant?.fecha_vencimiento || null,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/admin/login — admin del SaaS ───────────────
router.post('/admin/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(422).json({ success: false, message: 'Email y contraseña requeridos.' });

    const admin = await queryOne(
      'SELECT * FROM admin_usuarios WHERE email = ? AND activo = 1',
      [email.trim().toLowerCase()]
    );

    if (!admin || !(await bcrypt.compare(password, admin.password)))
      return res.status(401).json({ success: false, message: 'Credenciales incorrectas.' });

    const token = jwt.sign(
      { id: admin.id, email: admin.email, tipo: 'admin' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    return res.json({
      success: true,
      token,
      user: { id: admin.id, nombre: admin.nombre, email: admin.email, tipo: 'admin' },
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/recuperar — solicitar reset de password ────
router.post('/recuperar', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(422).json({ success: false, message: 'Email requerido.' });

    const user = await queryOne(
      'SELECT id FROM saas_portal_usuarios WHERE email = ? AND activo = 1',
      [email.trim().toLowerCase()]
    );

    // Siempre responder igual para no revelar si el email existe
    if (user) {
      const token   = require('crypto').randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 horas
      await query(
        'UPDATE saas_portal_usuarios SET reset_token=?, reset_expires=? WHERE id=?',
        [token, expires, user.id]
      );
      // Enviar email de recuperación
      const emailService = require('../services/email.service');
      await emailService.enviarRecuperacion(email, token);
    }

    return res.json({ success: true, message: 'Si el email existe, recibirás instrucciones.' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/reset — cambiar password con token ────────
router.post('/reset', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password || password.length < 8)
      return res.status(422).json({ success: false, message: 'Token y contraseña (min 8 chars) requeridos.' });

    const user = await queryOne(
      'SELECT id FROM saas_portal_usuarios WHERE reset_token=? AND reset_expires > NOW()',
      [token]
    );

    if (!user)
      return res.status(400).json({ success: false, message: 'Token inválido o expirado.' });

    const hash = await bcrypt.hash(password, 10);
    await query(
      'UPDATE saas_portal_usuarios SET password=?, reset_token=NULL, reset_expires=NULL WHERE id=?',
      [hash, user.id]
    );

    return res.json({ success: true, message: 'Contraseña actualizada correctamente.' });
  } catch (err) { next(err); }
});

module.exports = router;