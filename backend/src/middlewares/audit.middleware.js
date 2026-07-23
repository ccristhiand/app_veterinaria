'use strict';

/**
 * VetClinic SaaS — Middleware de Auditoría
 * Registra automáticamente todas las operaciones CRUD en vet_master
 * 
 * Uso en routes:
 *   router.post('/', audit('mascota:creada', 'mascotas'), async (req, res, next) => { ... })
 * 
 * O manual dentro de un handler:
 *   await auditLog(req, res, 'factura:anulada', 'facturacion', { anterior, nuevo })
 */

const { masterQuery } = require('../config/masterDB');

// ── Mapeo de módulos por ruta ──────────────────────────────────
const MODULO_MAP = {
  '/mascotas'         : 'mascotas',
  '/propietarios'     : 'propietarios',
  '/citas'            : 'citas',
  '/historia'         : 'historia_clinica',
  '/vacunas'          : 'vacunas',
  '/inventario'       : 'inventario',
  '/facturas'         : 'facturacion',
  '/caja'             : 'caja',
  '/usuarios'         : 'usuarios',
  '/estetica'         : 'estetica',
  '/consentimientos'  : 'consentimientos',
  '/carnet'           : 'carnet',
  '/empresa'          : 'configuracion',
  '/servicios'        : 'servicios',
  '/reportes'         : 'reportes',
  '/auth'             : 'autenticacion',
};

// ── Mapeo de acciones por método HTTP ─────────────────────────
const ACCION_MAP = {
  POST   : 'creado',
  PUT    : 'actualizado',
  PATCH  : 'actualizado',
  DELETE : 'eliminado',
  GET    : 'consultado',
};

/**
 * Función principal de log — fire and forget (no bloquea)
 */
async function auditLog(req, res, accionOverride = null, moduloOverride = null, {
  anterior  = null,
  nuevo     = null,
  resultado = 'exito',
  error     = null,
  duracion  = null,
} = {}) {
  try {
    // Detectar módulo
    const path    = req.path || req.url || '';
    const modulo  = moduloOverride || Object.entries(MODULO_MAP)
      .find(([k]) => path.includes(k))?.[1] || 'sistema';

    // Detectar acción
    const metodo  = req.method?.toUpperCase() || 'GET';
    const accion  = accionOverride || `${modulo}:${ACCION_MAP[metodo] || 'consultado'}`;

    // Solo loguear CRUD + auth (no GET de listados)
    if (metodo === 'GET' && !accionOverride && !path.includes('/auth')) return;

    const tenant  = req.tenant;
    const user    = req.user;

    await masterQuery(
      `INSERT INTO tenant_logs
        (tenant_id, tenant_nombre, usuario_id, usuario_nombre, usuario_rol,
         accion, modulo, metodo_http, endpoint, ip, user_agent,
         data_anterior, data_nueva, resultado, error_mensaje, duracion_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        tenant?.id            || null,
        tenant?.nombre_clinica || tenant?.slug || null,
        user?.id              || null,
        user?.nombre          || null,
        user?.rol             || null,
        accion,
        modulo,
        metodo,
        req.originalUrl       || path,
        req.ip                || req.headers['x-real-ip'] || null,
        req.headers['user-agent']?.substring(0, 500) || null,
        anterior  ? JSON.stringify(anterior)  : null,
        nuevo     ? JSON.stringify(nuevo)     : null,
        resultado,
        error     ? String(error).substring(0, 1000) : null,
        duracion,
      ]
    );
  } catch (err) {
    // El log nunca debe romper la app
    console.error('[audit] Error al guardar log:', err.message);
  }
}

/**
 * Middleware automático para rutas — wrappea el res.json para capturar respuesta
 * 
 * Uso: router.post('/', auditMiddleware(), async handler)
 */
function auditMiddleware(accionOverride = null, moduloOverride = null) {
  return async (req, res, next) => {
    const inicio = Date.now();
    const metodo = req.method?.toUpperCase();

    // Solo loguear operaciones CRUD
    if (metodo === 'GET') return next();

    // Capturar body antes de que se modifique
    const bodyOriginal = req.body ? { ...req.body } : null;
    // Remover password del log
    if (bodyOriginal?.password)         delete bodyOriginal.password;
    if (bodyOriginal?.password_confirm) delete bodyOriginal.password_confirm;
    if (bodyOriginal?.password_actual)  delete bodyOriginal.password_actual;
    if (bodyOriginal?.password_nuevo)   delete bodyOriginal.password_nuevo;

    // Interceptar res.json para capturar la respuesta
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      const duracion  = Date.now() - inicio;
      const resultado = res.statusCode < 400 ? 'exito' : 'error';
      const error     = resultado === 'error' ? data?.message : null;

      // Determinar anterior y nuevo según el método
      let anterior = null;
      let nuevo    = null;

      if (metodo === 'POST') {
        nuevo = data?.data || bodyOriginal;
      } else if (metodo === 'PUT' || metodo === 'PATCH') {
        nuevo = bodyOriginal;
      } else if (metodo === 'DELETE') {
        anterior = bodyOriginal;
      }

      // Log asíncrono — no bloquea
      auditLog(req, res, accionOverride, moduloOverride, {
        anterior, nuevo, resultado, error, duracion
      });

      return originalJson(data);
    };

    next();
  };
}

/**
 * Middleware de log para login/logout (sin req.tenant ni req.user completo)
 */
function auditAuth(accion, tenantId, tenantNombre, usuario, ip, userAgent, resultado = 'exito', error = null) {
  masterQuery(
    `INSERT INTO tenant_logs
      (tenant_id, tenant_nombre, usuario_id, usuario_nombre, usuario_rol,
       accion, modulo, ip, user_agent, resultado, error_mensaje)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tenantId, tenantNombre,
      usuario?.id || null,
      usuario?.nombre || null,
      usuario?.rol || null,
      accion, 'autenticacion',
      ip, userAgent?.substring(0, 500),
      resultado, error,
    ]
  ).catch(err => console.error('[audit] Auth log error:', err.message));
}

module.exports = { auditLog, auditMiddleware, auditAuth };