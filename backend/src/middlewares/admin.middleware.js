'use strict';

const jwt = require('jsonwebtoken');

// Sin fallback: un secreto por defecto permitiría fabricar tokens de super admin.
const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET;
if (!ADMIN_SECRET || ADMIN_SECRET.length < 32) {
  throw new Error('ADMIN_JWT_SECRET no definido o demasiado corto (mínimo 32 caracteres).');
}
if (ADMIN_SECRET === process.env.JWT_SECRET) {
  throw new Error('ADMIN_JWT_SECRET no puede ser igual a JWT_SECRET.');
}

// ── Auth del panel admin SaaS ────────────────────────────────────
// Se monta en index.js sobre todo /admin/api, excepto POST /login.
function adminAuth(req, res, next) {
  if (req.method === 'POST' && req.path === '/login') return next();

  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Token requerido.' });
  try {
    req.adminUser = jwt.verify(token, ADMIN_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token inválido.' });
  }
}

module.exports = { adminAuth, ADMIN_SECRET };
