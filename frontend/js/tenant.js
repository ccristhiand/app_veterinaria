/**
 * VetClinic SaaS — Tenant branding dinámico
 * Se carga en todas las páginas ANTES que layout.js
 */

(async function initTenant() {
  try {
    // Cargar config del tenant (público, sin auth)
    const _tenantBase = window.location.hostname === 'localhost' || window.location.hostname.endsWith('.test') ? 'http://localhost:4000' : 'https://api.' + window.location.hostname.split('.').slice(-2).join('.');
    const res = await fetch(`${window.API_URL || _tenantBase}/api/v1/tenant/config`, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) return;
    const { data: cfg } = await res.json();

    // ── Guardar config globalmente ────────────────────────────────
    window.TENANT_CONFIG = cfg;

    // ── Aplicar colores CSS ────────────────────────────────────────
    const root = document.documentElement;
    if (cfg.color_primario) {
      root.style.setProperty('--green-500', cfg.color_primario);
      root.style.setProperty('--green-600', shadeColor(cfg.color_primario, -10));
      root.style.setProperty('--green-100', shadeColor(cfg.color_primario, 60));
      root.style.setProperty('--green-50',  shadeColor(cfg.color_primario, 80));
    }
    if (cfg.color_sidebar) {
      root.style.setProperty('--green-900', cfg.color_sidebar);
      root.style.setProperty('--green-800', shadeColor(cfg.color_sidebar, 10));
    }
    if (cfg.color_acento) {
      root.style.setProperty('--green-700', cfg.color_acento);
    }

    // ── Título del navegador ──────────────────────────────────────
    const paginaActual = document.title.split('—')[1]?.trim() || '';
    document.title = paginaActual
      ? `${cfg.nombre_clinica} — ${paginaActual}`
      : cfg.nombre_clinica;

    // ── Favicon dinámico ──────────────────────────────────────────
    if (cfg.favicon_url) {
      let link = document.querySelector("link[rel~='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = cfg.favicon_url;
    }

    // ── Meta theme color (móvil) ──────────────────────────────────
    let metaTheme = document.querySelector('meta[name="theme-color"]');
    if (!metaTheme) {
      metaTheme = document.createElement('meta');
      metaTheme.name = 'theme-color';
      document.head.appendChild(metaTheme);
    }
    metaTheme.content = cfg.color_sidebar || '#0d3b2e';

    // ── Módulos: ocultar links del sidebar si no están habilitados ──
    // Se ejecuta después del DOM (layout.js lo construye)
    window._tenantModulos = cfg.modulos || {};

  } catch (e) {
    console.warn('No se pudo cargar config del tenant:', e.message);
  }
})();

/**
 * Aclara u oscurece un color hex.
 * amount positivo = más claro, negativo = más oscuro
 */
function shadeColor(hex, amount) {
  const num = parseInt(hex.replace('#',''), 16);
  const r   = Math.min(255, Math.max(0, (num >> 16) + amount * 2.55));
  const g   = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + amount * 2.55));
  const b   = Math.min(255, Math.max(0, (num & 0x0000FF) + amount * 2.55));
  return '#' + [r,g,b].map(v => Math.round(v).toString(16).padStart(2,'0')).join('');
}

/**
 * Aplica el logo del tenant al sidebar una vez que esté construido.
 * layout.js debe llamar a esto después de renderShell().
 */
function applyTenantLogo() {
  const cfg = window.TENANT_CONFIG;
  if (!cfg) return;

  const logoText = document.querySelector('.sb-logo-text');
  const logoIcon = document.querySelector('.sb-logo-icon');

  if (logoText) logoText.textContent = cfg.nombre_clinica;

  if (cfg.logo_url && logoIcon) {
    logoIcon.innerHTML = `<img src="${cfg.logo_url}"
      style="width:100%;height:100%;object-fit:contain;border-radius:8px"
      onerror="this.parentElement.innerHTML='🐾'"/>`;
  }

  // Ocultar links de módulos deshabilitados
  const modulos = window._tenantModulos || {};
  const mapa = {
    'facturacion.html' : modulos.facturacion,
    'inventario.html'  : modulos.inventario,
  };

  document.querySelectorAll('.sb-link').forEach(link => {
    const href = link.getAttribute('href') || '';
    const nombre = Object.keys(mapa).find(k => href.includes(k));
    if (nombre && mapa[nombre] === false) {
      link.style.display = 'none';
    }
  });
}