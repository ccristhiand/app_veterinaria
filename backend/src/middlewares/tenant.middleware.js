'use strict';

const { masterQuery }                      = require('../config/masterDB');
const { getPoolForTenant, createDBHelper } = require('../config/tenantDB');
const logger                               = require('../config/logger');

// Cache de tenants: { subdominio: { tenant, config, expira } }
const tenantCache = new Map();
const CACHE_TTL   = 5 * 60 * 1000; // 5 minutos

/**
 * Middleware principal — resuelve el tenant por subdominio.
 * Agrega req.tenant y req.db a cada request.
 */
async function resolveTenant(req, res, next) {
  try {
    // Leer hostname — en producción viene de req.hostname (Nginx lo pasa)
    // En desarrollo local viene del header X-Tenant-Host enviado por el frontend
    const host       = req.headers['x-tenant-host'] ||
                       req.hostname ||
                       req.headers.host?.split(':')[0] || '';
    const subdominio = host.toLowerCase();

    console.log('TENANT RESOLVIENDO:', subdominio);

    // Buscar en caché primero
    let tenantData = tenantCache.get(subdominio);

    if (!tenantData || Date.now() > tenantData.expira) {
      // Buscar en DB maestra — incluir suspendidos para dar mensaje apropiado
      const [tenant] = await masterQuery(
        `SELECT t.*, tc.*
         FROM tenants t
         LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
         WHERE t.subdominio = ?
         LIMIT 1`,
        [subdominio]
      );

      if (!tenant) {
        // ── SOLO DESARROLLO LOCAL ─────────────────────────────────
        // Cuando se accede desde localhost sin subdominio,
        // usa el primer tenant activo como fallback.
        // En producción esto no aplica porque siempre hay subdominio.
        if (subdominio === 'localhost' || subdominio === '127.0.0.1') {
          const [devTenant] = await masterQuery(
            `SELECT t.*, tc.*
             FROM tenants t
             LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
             WHERE t.activo = 1
             ORDER BY t.id ASC
             LIMIT 1`
          );
          if (devTenant) {
            tenantData = { tenant: devTenant, expira: Date.now() + CACHE_TTL };
            tenantCache.set(subdominio, tenantData);
          }
        }
        // ─────────────────────────────────────────────────────────

        if (!tenantData) {
          return res.status(404).json({
            success: false,
            message: 'Clínica no encontrada.',
            code   : 'TENANT_NOT_FOUND',
          });
        }
      } else {
        // Si está suspendida, cachear por menos tiempo
        const ttl = tenant.activo ? CACHE_TTL : 30000;
        tenantData = { tenant, expira: Date.now() + ttl };
        tenantCache.set(subdominio, tenantData);
      }
    }

    const { tenant } = tenantData;

    // ── Verificar si está suspendida ──────────────────────────────
    if (!tenant.activo) {
      const motivo = tenant.motivo_suspension
        ? `Motivo: ${tenant.motivo_suspension}`
        : 'Contacta al administrador para más información.';
      return res.status(403).json({
        success: false,
        message: `Esta clínica ha sido suspendida. ${motivo}`,
        code   : 'TENANT_SUSPENDED',
        motivo : tenant.motivo_suspension || null,
      });
    }

    // Verificar trial si aplica
    if (tenant.trial_hasta && new Date(tenant.trial_hasta) < new Date()) {
      return res.status(402).json({
        success: false,
        message: 'El período de prueba ha vencido. Contacta a soporte.',
        code   : 'TRIAL_EXPIRED',
      });
    }

    // Adjuntar tenant y helper de DB al request
    req.tenant = tenant;
    req.db     = createDBHelper(getPoolForTenant(tenant));

    next();
  } catch (err) {
    logger.error(`Error resolviendo tenant: ${err.message}`);
    next(err);
  }
}

/**
 * Invalida el caché de un tenant específico
 * (llamar después de actualizar config).
 */
function invalidateTenantCache(subdominio) {
  tenantCache.delete(subdominio);
}

/**
 * Middleware para verificar que un módulo está habilitado.
 * Uso: router.use(requireModule('facturacion'))
 */
function requireModule(modulo) {
  return (req, res, next) => {
    const campo = `modulo_${modulo}`;
    if (!req.tenant?.[campo]) {
      return res.status(403).json({
        success: false,
        message: `El módulo de ${modulo} no está habilitado para esta clínica.`,
        code   : 'MODULE_DISABLED',
      });
    }
    next();
  };
}

module.exports = { resolveTenant, invalidateTenantCache, requireModule };