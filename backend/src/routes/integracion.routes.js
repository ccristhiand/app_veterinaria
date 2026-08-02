'use strict';

/**
 * VetNetcodip SaaS — Integración DNI/RUC
 * Base: /api/v1/integracion
 *
 * Proxy inteligente hacia apidocument.netcodip.com
 * - Gestiona el JWT de la API externa (auto-refresh)
 * - Registra cada consulta en tenant_api_consumo (vet_master)
 * - Solo funciona si el tenant tiene la integración activa
 */

const { Router } = require('express');
const { authenticate } = require('../middlewares/auth.middleware');
const { masterQuery } = require('../config/masterDB');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const router = Router();
router.use(authenticate);

const APIDOC_URL      = process.env.APIDOC_URL      || 'https://apidocument.netcodip.com';
const APIDOC_EMAIL    = process.env.APIDOC_EMAIL    || '';
const APIDOC_PASSWORD = process.env.APIDOC_PASSWORD || '';

// Cache en memoria del token (válido 7 días según docs)
let _cachedToken    = null;
let _cachedTokenExp = null;

// ── Obtener/renovar token de apidocument ─────────────────────────
async function getApiDocToken() {
  const now = new Date();

  // Usar token en memoria si sigue vigente (con 1h de margen)
  if (_cachedToken && _cachedTokenExp && _cachedTokenExp > new Date(now.getTime() + 60 * 60 * 1000)) {
    return _cachedToken;
  }

  // Intentar token guardado en vet_master
  const [cfg] = await masterQuery(
    'SELECT apidoc_token, apidoc_token_exp FROM tenant_config LIMIT 1'
  ).catch(() => [null]);

  if (cfg?.apidoc_token && cfg?.apidoc_token_exp) {
    const exp = new Date(cfg.apidoc_token_exp);
    if (exp > new Date(now.getTime() + 60 * 60 * 1000)) {
      _cachedToken    = cfg.apidoc_token;
      _cachedTokenExp = exp;
      return _cachedToken;
    }
  }

  // Generar nuevo token
  const email    = process.env.APIDOC_EMAIL    || '';
  const password = process.env.APIDOC_PASSWORD || '';

  if (!email || !password) {
    throw new Error('Credenciales de apidocument no configuradas en .env');
  }

  const res  = await fetch(`${APIDOC_URL}/api/auth/login`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ email, password }),
  });

  if (!res.ok) throw new Error('Error al autenticar con apidocument');
  const data = await res.json();
  if (!data.ok || !data.token) throw new Error('Token inválido de apidocument');

  // Guardar en memoria y en master (para todos los workers)
  _cachedToken    = data.token;
  _cachedTokenExp = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000); // 6 días

  await masterQuery(
    'UPDATE tenant_config SET apidoc_token = ?, apidoc_token_exp = ? WHERE id > 0',
    [_cachedToken, _cachedTokenExp]
  ).catch(() => {});

  return _cachedToken;
}

// ── Registrar consumo en vet_master ──────────────────────────────
async function registrarConsumo(tenantId, tenantSlug, tipo, fuente, numero) {
  try {
    await masterQuery(
      `INSERT INTO tenant_api_consumo (tenant_id, tenant_slug, tipo, fuente, numero)
       VALUES (?,?,?,?,?)`,
      [tenantId, tenantSlug, tipo, fuente, numero]
    );
  } catch (e) {
    console.error('[integracion] Error registrando consumo:', e.message);
  }
}

// ── GET /api/v1/integracion/dni/:dni ─────────────────────────────
router.get('/dni/:dni', async (req, res, next) => {
  try {
    const { dni } = req.params;

    // Validar formato
    if (!/^\d{8}$/.test(dni)) {
      return res.status(422).json({ success: false, message: 'El DNI debe tener 8 dígitos.' });
    }

    // Verificar que la integración RENIEC está activa para este tenant
    const [cfg] = await masterQuery(
      'SELECT integracion_reniec_activo FROM tenant_config WHERE tenant_id = ?',
      [req.tenant.id]
    );

    if (!cfg?.integracion_reniec_activo) {
      return res.status(403).json({
        success: false,
        message: 'La integración con RENIEC no está activa para esta clínica.',
        code   : 'INTEGRACION_INACTIVA',
      });
    }

    // Obtener token
    const token = await getApiDocToken();

    // Consultar API
    const apiRes = await fetch(`${APIDOC_URL}/api/dni/${dni}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (apiRes.status === 404) {
      return res.status(404).json({ success: false, message: 'DNI no encontrado en RENIEC.' });
    }
    if (!apiRes.ok) {
      return res.status(apiRes.status).json({ success: false, message: 'Error consultando RENIEC.' });
    }

    const data = await apiRes.json();

    // Registrar consumo
    await registrarConsumo(
      req.tenant.id,
      req.tenant.slug,
      'dni',
      data.fuente || 'api',
      dni
    );

    return res.json({
      success: true,
      fuente : data.fuente,
      data   : {
        dni            : data.datos?.dni,
        nombres        : data.datos?.nombres,
        apellido_paterno: data.datos?.apellido_paterno,
        apellido_materno: data.datos?.apellido_materno,
        nombre_completo : data.datos?.nombre_completo,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /api/v1/integracion/ruc/:ruc ─────────────────────────────
router.get('/ruc/:ruc', async (req, res, next) => {
  try {
    const { ruc } = req.params;

    if (!/^\d{11}$/.test(ruc)) {
      return res.status(422).json({ success: false, message: 'El RUC debe tener 11 dígitos.' });
    }

    // Verificar integración SUNAT activa
    const [cfg] = await masterQuery(
      'SELECT integracion_sunat_activo FROM tenant_config WHERE tenant_id = ?',
      [req.tenant.id]
    );

    if (!cfg?.integracion_sunat_activo) {
      return res.status(403).json({
        success: false,
        message: 'La integración con SUNAT no está activa para esta clínica.',
        code   : 'INTEGRACION_INACTIVA',
      });
    }

    const token  = await getApiDocToken();
    const apiRes = await fetch(`${APIDOC_URL}/api/ruc/${ruc}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (apiRes.status === 404) {
      return res.status(404).json({ success: false, message: 'RUC no encontrado en SUNAT.' });
    }
    if (!apiRes.ok) {
      return res.status(apiRes.status).json({ success: false, message: 'Error consultando SUNAT.' });
    }

    const data = await apiRes.json();
    const d    = data.datos || {};

    await registrarConsumo(req.tenant.id, req.tenant.slug, 'ruc', data.fuente || 'api', ruc);

    return res.json({
      success: true,
      fuente : data.fuente,
      data   : {
        ruc              : d.ruc,
        razon_social     : d.razon_social || d.nombre_o_razon_social,
        estado           : d.estado_contribuyente || d.estado,
        condicion        : d.condicion_contribuyente || d.condicion,
        direccion        : d.direccion,
        departamento     : d.departamento,
        provincia        : d.provincia,
        distrito         : d.distrito,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /api/v1/integracion/estado ───────────────────────────────
// Estado de las integraciones del tenant actual
router.get('/estado', async (req, res, next) => {
  try {
    const [cfg] = await masterQuery(
      'SELECT integracion_reniec_activo, integracion_sunat_activo FROM tenant_config WHERE tenant_id = ?',
      [req.tenant.id]
    );
    return res.json({
      success: true,
      data: {
        reniec: !!cfg?.integracion_reniec_activo,
        sunat : !!cfg?.integracion_sunat_activo,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;