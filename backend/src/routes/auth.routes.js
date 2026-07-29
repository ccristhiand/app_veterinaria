'use strict';

const { Router }   = require('express');
const bcrypt       = require('bcryptjs');
const { signTokens, authenticate } = require('../middlewares/auth.middleware');
const { auditLog, auditMiddleware, auditAuth } = require('../middlewares/audit.middleware');

const router = Router();

// ── Helper: obtener sede del usuario ─────────────────────────────
async function getSedeUsuario(db, sedeId) {
  if (!sedeId) return null;
  const [sede] = await db.query(
    'SELECT id, nombre, ciudad FROM sedes WHERE id = ? AND activo = 1',
    [sedeId]
  ).catch(() => [null]);
  return sede || null;
}

// POST /api/v1/auth/login
router.post('/login', auditMiddleware('autenticacion:creado', 'autenticacion'), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(422).json({ success: false, message: 'Email y password requeridos.' });
    }

    // ── CAMBIO: incluir sede_id en la query ──────────────────────
    const [user] = await req.db.query(
      'SELECT * FROM usuarios WHERE email = ? AND activo = 1',
      [email.trim().toLowerCase()]
    );
    if (!user) return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      auditAuth('login:fallido', req.tenant?.id, req.tenant?.nombre_clinica, { nombre: email }, req.ip, req.headers['user-agent'], 'error', 'Credenciales inválidas');
      return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });
    }

    // Si debe cambiar password → devolver flag especial sin tokens completos
    if (user.must_change_password) {
      const jwt    = require('jsonwebtoken');
      const SECRET = process.env.JWT_SECRET || 'vetclinic-key';
      const tempToken = jwt.sign(
        { id: user.id, email: user.email, scope: 'change_password' },
        SECRET,
        { expiresIn: '10m' }
      );
      return res.json({
        success             : true,
        must_change_password: true,
        temp_token          : tempToken,
        message             : 'Debes cambiar tu contraseña antes de continuar.',
        user: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
      });
    }

    // ── CAMBIO: buscar la sede del usuario ───────────────────────
    const sede = await getSedeUsuario(req.db, user.sede_id);

    const { accessToken, refreshToken } = signTokens(user);
    auditAuth('login:exitoso', req.tenant?.id, req.tenant?.nombre_clinica, user, req.ip, req.headers['user-agent']);

    return res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        user: {
          id    : user.id,
          nombre: user.nombre,
          email : user.email,
          rol   : user.rol,
          // ── NUEVO: datos de sede ─────────────────────────────
          sede_id    : user.sede_id || null,
          sede_nombre: sede?.nombre || null,
          sede_ciudad: sede?.ciudad || null,
        },
      },
    });
  } catch (err) { next(err); }
});

// POST /api/v1/auth/change-password — cambiar password (primer login o desde perfil)
router.post('/change-password', auditMiddleware('autenticacion:creado', 'autenticacion'), async (req, res, next) => {
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

      if (!password_actual) {
        return res.status(422).json({ success: false, message: 'Debes ingresar tu contraseña actual.' });
      }
      const [userCheck] = await req.db.query('SELECT password FROM usuarios WHERE id=?', [userId]);
      const okPass = await bcrypt.compare(password_actual, userCheck.password);
      if (!okPass) return res.status(401).json({ success: false, message: 'La contraseña actual es incorrecta.' });
    }

    const hash = await bcrypt.hash(password_nuevo, 10);
    await req.db.query(
      'UPDATE usuarios SET password=?, must_change_password=0, last_password_change=NOW() WHERE id=?',
      [hash, userId]
    );

    // ── CAMBIO: incluir sede en los tokens de retorno ────────────
    const [user] = await req.db.query(
      'SELECT id, nombre, email, rol, sede_id FROM usuarios WHERE id=?', [userId]
    );
    const sede = await getSedeUsuario(req.db, user.sede_id);
    const { accessToken, refreshToken } = signTokens(user);

    return res.json({
      success: true,
      message: 'Contraseña actualizada correctamente.',
      data: {
        accessToken,
        refreshToken,
        user: {
          id         : user.id,
          nombre     : user.nombre,
          email      : user.email,
          rol        : user.rol,
          sede_id    : user.sede_id || null,
          sede_nombre: sede?.nombre || null,
          sede_ciudad: sede?.ciudad || null,
        },
      },
    });
  } catch (err) { next(err); }
});

// POST /api/v1/auth/refresh
router.post('/refresh', auditMiddleware('autenticacion:creado', 'autenticacion'), async (req, res, next) => {
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