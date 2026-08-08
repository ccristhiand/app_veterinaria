'use strict';

const jwt = require('jsonwebtoken');

// Acepta tanto el JWT del admin veterinario como el JWT propio de pagos
const JWT_SECRET       = process.env.PAGOS_JWT_SECRET  || 'pagos-secret-2026';
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET  || process.env.JWT_SECRET || 'APP_NETCODIP_MASCOTAS_ADMIN';

function authCliente(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, message: 'Token requerido.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.tipo !== 'cliente')
      return res.status(403).json({ success: false, message: 'Acceso no autorizado.' });
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token inválido o expirado.' });
  }
}

function authAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, message: 'Token requerido.' });

  // Intentar primero con el secret del admin veterinario
  let payload = null;
  try { payload = jwt.verify(token, ADMIN_JWT_SECRET); } catch {}

  // Si falla, intentar con el secret propio de pagos
  if (!payload) {
    try { payload = jwt.verify(token, JWT_SECRET); } catch {}
  }

  if (!payload)
    return res.status(401).json({ success: false, message: 'Token inválido o expirado.' });

  // Aceptar tanto admins del sistema veterinario como del portal de pagos
  if (payload.tipo !== 'admin' && payload.rol !== 'admin' && payload.rol !== 'superadmin')
    return res.status(403).json({ success: false, message: 'Acceso de admin requerido.' });

  req.admin = payload;
  next();
}

module.exports = { authCliente, authAdmin };