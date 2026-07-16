'use strict';

const { Router }   = require('express');
const bcrypt       = require('bcryptjs');
const { signTokens, authenticate } = require('../middlewares/auth.middleware');

const router = Router();

// POST /api/v1/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(422).json({ success: false, message: 'Email y password requeridos.' });
    }

    const [user] = await req.db.query(
      'SELECT * FROM usuarios WHERE email = ? AND activo = 1',
      [email.trim().toLowerCase()]
    );
    if (!user) return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });

    // Si debe cambiar password → devolver flag especial sin tokens completos
    if (user.must_change_password) {
      // Token temporal solo para cambiar password (expira en 10 min)
      const jwt    = require('jsonwebtoken');
      const SECRET = process.env.JWT_SECRET || 'vetclinic-key';
      const tempToken = jwt.sign(
        { id: user.id, email: user.email, scope: 'change_password' },
        SECRET,
        { expiresIn: '10m' }
      );
      return res.json({
        success            : true,
        must_change_password: true,
        temp_token         : tempToken,
        message            : 'Debes cambiar tu contraseña antes de continuar.',
        user: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
      });
    }

    const { accessToken, refreshToken } = signTokens(user);
    return res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        user: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
      },
    });
  } catch (err) { next(err); }
});

// POST /api/v1/auth/change-password — cambiar password (primer login o desde perfil)
router.post('/change-password', async (req, res, next) => {
  try {
    const { temp_token, password_actual, password_nuevo, password_confirm } = req.body;

    if (!password_nuevo || password_nuevo.length < 8) {
      return res.status(422).json({ success: false, message: 'La nueva contraseña debe tener al menos 8 caracteres.' });
    }
    if (password_nuevo !== password_confirm) {
      return res.status(422).json({ success: false, message: 'Las contraseñas no coinciden.' });
    }

    let userId;

    if (temp_token) {
      // Flujo primer login — verificar token temporal
      const jwt    = require('jsonwebtoken');
      const SECRET = process.env.JWT_SECRET || 'vetclinic-key';
      let decoded;
      try {
        decoded = jwt.verify(temp_token, SECRET);
      } catch {
        return res.status(401).json({ success: false, message: 'Token inválido o expirado. Inicia sesión nuevamente.' });
      }
      if (decoded.scope !== 'change_password') {
        return res.status(401).json({ success: false, message: 'Token no autorizado para esta acción.' });
      }
      userId = decoded.id;
    } else {
      // Flujo desde perfil — requiere autenticación normal
      const authHeader = req.headers.authorization;
      if (!authHeader) return res.status(401).json({ success: false, message: 'No autenticado.' });
      const jwt    = require('jsonwebtoken');
      const SECRET = process.env.JWT_SECRET || 'vetclinic-key';
      let decoded;
      try {
        decoded = jwt.verify(authHeader.replace('Bearer ', ''), SECRET);
      } catch {
        return res.status(401).json({ success: false, message: 'Token inválido.' });
      }
      userId = decoded.id;

      // Verificar password actual
      if (!password_actual) {
        return res.status(422).json({ success: false, message: 'Debes ingresar tu contraseña actual.' });
      }
      const [user] = await req.db.query('SELECT password FROM usuarios WHERE id=?', [userId]);
      const ok = await bcrypt.compare(password_actual, user.password);
      if (!ok) return res.status(401).json({ success: false, message: 'La contraseña actual es incorrecta.' });
    }

    // Actualizar password
    const hash = await bcrypt.hash(password_nuevo, 10);
    await req.db.query(
      'UPDATE usuarios SET password=?, must_change_password=0, last_password_change=NOW() WHERE id=?',
      [hash, userId]
    );

    // Devolver tokens completos para que el usuario entre directo
    const [user] = await req.db.query(
      'SELECT id, nombre, email, rol FROM usuarios WHERE id=?', [userId]
    );
    const { accessToken, refreshToken } = signTokens(user);

    return res.json({
      success: true,
      message: 'Contraseña actualizada correctamente.',
      data: { accessToken, refreshToken, user },
    });
  } catch (err) { next(err); }
});

// POST /api/v1/auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(422).json({ success: false, message: 'refreshToken requerido.' });

    const jwt     = require('jsonwebtoken');
    const SECRET  = process.env.JWT_REFRESH_SECRET || 'vetclinic-refresh-key';
    const decoded = jwt.verify(refreshToken, SECRET);

    const [user] = await req.db.query(
      'SELECT id, nombre, email, rol FROM usuarios WHERE id = ? AND activo = 1',
      [decoded.id]
    );
    if (!user) return res.status(401).json({ success: false, message: 'Usuario no válido.' });

    const tokens = signTokens(user);
    return res.json({ success: true, ...tokens });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token inválido o expirado.' });
    }
    next(err);
  }
});

// GET /api/v1/auth/me
router.get('/me', authenticate, async (req, res) => {
  return res.json({ success: true, data: req.user });
});

module.exports = router;