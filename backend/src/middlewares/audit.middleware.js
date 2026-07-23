'use strict';

const { masterQuery } = require('../config/masterDB');

// ── Mapeo de módulos por ruta ──────────────────────────────────
const MODULO_MAP = {
  '/mascotas'        : 'mascotas',
  '/propietarios'    : 'propietarios',
  '/citas'           : 'citas',
  '/historia'        : 'historia_clinica',
  '/vacunas'         : 'vacunas',
  '/inventario'      : 'inventario',
  '/facturas'        : 'facturacion',
  '/caja'            : 'caja',
  '/usuarios'        : 'usuarios',
  '/estetica'        : 'estetica',
  '/consentimientos' : 'consentimientos',
  '/carnet'          : 'carnet',
  '/empresa'         : 'configuracion',
  '/servicios'       : 'servicios',
  '/auth'            : 'autenticacion',
};

// ── Mapeo tabla por módulo ─────────────────────────────────────
const TABLA_MAP = {
  'mascotas'         : 'mascotas',
  'propietarios'     : 'propietarios',
  'citas'            : 'citas',
  'historia_clinica' : 'historia_clinica',
  'vacunas'          : 'vacunas',
  'inventario'       : 'inventario',
  'facturacion'      : 'facturas',
  'caja'             : 'caja_cierres',
  'usuarios'         : 'usuarios',
  'estetica'         : 'servicios_estetica',
  'consentimientos'  : 'consentimientos_plantillas',
  'servicios'        : 'servicios_catalogo',
  'configuracion'    : 'empresa_config',
};

/**
 * Función principal de log — fire and forget
 */
async function auditLog(req, res, accionOverride = null, moduloOverride = null, {
  anterior  = null,
  nuevo     = null,
  resultado = 'exito',
  error     = null,
  duracion  = null,
} = {}) {
  try {
    const path   = req.path || req.url || '';
    const modulo = moduloOverride || Object.entries(MODULO_MAP)
      .find(([k]) => path.includes(k))?.[1] || 'sistema';

    const metodo = req.method?.toUpperCase() || 'GET';
    const accion = accionOverride || `${modulo}:${metodo === 'POST' ? 'creado' : metodo === 'DELETE' ? 'eliminado' : 'actualizado'}`;

    if (metodo === 'GET' && !accionOverride) return;

    const tenant = req.tenant;
    const user   = req.user;

    await masterQuery(
      `INSERT INTO tenant_logs
        (tenant_id, tenant_nombre, usuario_id, usuario_nombre, usuario_rol,
         accion, modulo, metodo_http, endpoint, ip, user_agent,
         data_anterior, data_nueva, resultado, error_mensaje, duracion_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        tenant?.id             || null,
        tenant?.nombre_clinica || tenant?.slug || null,
        user?.id               || null,
        user?.nombre           || null,
        user?.rol              || null,
        accion, modulo, metodo,
        req.originalUrl || path,
        req.ip || req.headers['x-real-ip'] || null,
        req.headers['user-agent']?.substring(0, 500) || null,
        anterior ? JSON.stringify(anterior) : null,
        nuevo    ? JSON.stringify(nuevo)    : null,
        resultado,
        error ? String(error).substring(0, 1000) : null,
        duracion,
      ]
    );
  } catch (err) {
    console.error('[audit] Error al guardar log:', err.message);
  }
}

/**
 * Middleware automático — captura dato anterior en PUT/PATCH/DELETE
 * y lo incluye en el mismo registro de log
 */
function auditMiddleware(accionOverride = null, moduloOverride = null) {
  return async (req, res, next) => {
    const inicio = Date.now();
    const metodo = req.method?.toUpperCase();

    if (metodo === 'GET') return next();

    // Capturar body (sin passwords)
    const bodyOriginal = req.body ? { ...req.body } : null;
    ['password','password_confirm','password_actual','password_nuevo','password_admin']
      .forEach(k => { if (bodyOriginal?.[k]) delete bodyOriginal[k]; });

    // ── Capturar dato ANTERIOR para PUT/PATCH/DELETE ───────────
    let datAnterior = null;
    if (['PUT', 'PATCH', 'DELETE'].includes(metodo) && req.params?.id && req.db) {
      try {
        const modulo = moduloOverride || Object.entries(MODULO_MAP)
          .find(([k]) => (req.path||'').includes(k))?.[1];
        const tabla = modulo ? TABLA_MAP[modulo] : null;

        if (tabla) {
          const [row] = await req.db.query(
            `SELECT * FROM ${tabla} WHERE id = ?`, [req.params.id]
          );
          if (row) {
            // Remover password del dato anterior
            if (row.password) delete row.password;
            datAnterior = row;
          }
        }
      } catch { /* no crítico */ }
    }

    // ── Interceptar res.json para capturar respuesta ───────────
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      const duracion  = Date.now() - inicio;
      const resultado = res.statusCode < 400 ? 'exito' : 'error';
      const error     = resultado === 'error' ? data?.message : null;

      let anterior = datAnterior;
      let nuevo    = null;

      if (metodo === 'POST') {
        nuevo = data?.data || bodyOriginal;
      } else if (metodo === 'PUT' || metodo === 'PATCH') {
        nuevo = bodyOriginal;
      }
      // DELETE: solo anterior, sin nuevo

      auditLog(req, res, accionOverride, moduloOverride, {
        anterior, nuevo, resultado, error, duracion
      });

      return originalJson(data);
    };

    next();
  };
}

/**
 * Log específico para autenticación
 */
function auditAuth(accion, tenantId, tenantNombre, usuario, ip, userAgent, resultado = 'exito', error = null) {
  masterQuery(
    `INSERT INTO tenant_logs
      (tenant_id, tenant_nombre, usuario_id, usuario_nombre, usuario_rol,
       accion, modulo, ip, user_agent, resultado, error_mensaje)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tenantId, tenantNombre,
      usuario?.id    || null,
      usuario?.nombre || null,
      usuario?.rol    || null,
      accion, 'autenticacion',
      ip, userAgent?.substring(0, 500),
      resultado, error,
    ]
  ).catch(err => console.error('[audit] Auth log error:', err.message));
}

module.exports = { auditLog, auditMiddleware, auditAuth };