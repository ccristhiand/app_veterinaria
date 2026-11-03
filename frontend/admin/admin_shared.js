/**
 * VetClinic SaaS — Admin Shared JS
 * Sesión, fetch, formato, íconos, tema y el armazón (sidebar / barra móvil).
 * Los estilos están en admin.css.
 */
const _adminIsLocal = window.location.hostname === 'localhost' ||
                      window.location.hostname.endsWith('.test') ||
                      window.location.hostname === '127.0.0.1';
const _adminBase    = window.location.hostname.split('.').slice(-2).join('.');
const ADMIN_API     = _adminIsLocal
  ? 'http://localhost:4000/admin/api'
  : `https://api.${_adminBase}/admin/api`;

function getToken()  { return localStorage.getItem('admin_token'); }
function getAdmin()  { try { const r = localStorage.getItem('admin_user'); return r && r !== 'undefined' ? JSON.parse(r) : null; } catch { return null; } }
function isLoggedIn(){ return !!getToken(); }
function requireAuth() { if (!isLoggedIn()) { window.location.href = 'login.html'; return false; } return true; }
function cerrarSesion() { localStorage.removeItem('admin_token'); localStorage.removeItem('admin_user'); window.location.href = 'login.html'; }

async function adminFetch(path, opts = {}) {
  const res = await fetch(`${ADMIN_API}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}`, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { cerrarSesion(); return null; }
  return res;
}

// ── Íconos (SVG de trazo, 24×24) ──────────────────────────────
const _ADMIN_ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  clinic   : '<path d="M4 21V8.5L12 3l8 5.5V21"/><path d="M9.5 21v-5h5v5"/><path d="M12 7.5v5M9.5 10h5"/>',
  logs     : '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  backup   : '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  receipt  : '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  chat     : '<path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1-4.5A8.5 8.5 0 1 1 20.5 12z"/>',
  paw      : '<circle cx="6.5" cy="10" r="1.9"/><circle cx="10" cy="5.8" r="1.9"/><circle cx="14.5" cy="5.8" r="1.9"/><circle cx="18" cy="10" r="1.9"/><path d="M12.2 11.5c-2.7 0-5.2 3.3-5.2 5.8 0 1.7 1.3 2.5 2.7 2.5 1 0 1.6-.5 2.5-.5s1.5.5 2.5.5c1.4 0 2.7-.8 2.7-2.5 0-2.5-2.5-5.8-5.2-5.8z"/>',
  menu     : '<path d="M4 7h16M4 12h16M4 17h16"/>',
  more     : '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  x        : '<path d="M6 6l12 12M18 6L6 18"/>',
  sun      : '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon     : '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  logout   : '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>',
  check    : '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checkc   : '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  xc       : '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  alert    : '<path d="M12 3.5l9 16H3z"/><path d="M12 10v4.5M12 17.2v.01"/>',
  info     : '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.8v.01"/>',
  edit     : '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  plug     : '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
  card     : '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/>',
  ban      : '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  play     : '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5z"/>',
  refresh  : '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 3.5V8h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20.5V16h-4.5"/>',
  plus     : '<path d="M12 5v14M5 12h14"/>',
  gear     : '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  download : '<path d="M12 4v11M7 10.5l5 5 5-5"/><path d="M4 19.5h16"/>',
  upload   : '<path d="M12 16V5M7 9.5l5-5 5 5"/><path d="M4 19.5h16"/>',
  search   : '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  clock    : '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  key      : '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16.5 6.5l2.5 2.5M14 9l2 2"/>',
  link     : '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  trash    : '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  eye      : '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  copy     : '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  calendar : '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  chart    : '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
  users    : '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  bolt     : '<path d="M13 2.5L4.5 13.5H12l-1 8 8.5-11H12z"/>',
  phone    : '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  qr       : '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18zM14 18.5v2M18.5 14h2"/>',
  send     : '<path d="M21 3L10 14"/><path d="M21 3l-6.5 18-4.5-7-7-4.5z"/>',
  lock     : '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  money    : '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.8"/><path d="M6 9.5v.01M18 14.5v.01"/>',
  box      : '<path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/>',
  palette  : '<path d="M12 3a9 9 0 0 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-1.1-.9-1.5-.9-2.6 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  globe    : '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  wrench   : '<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3z"/><path d="M14.5 6.5L17 4l3 3-2.5 2.5"/>',
};

/** Logo de la marca (logo.jpg); si no carga, queda el ícono SVG. */
function _logoHtml() {
  return `<div class="sb-logo logo-img"><img src="logo.jpg" alt="VetClinic" onerror="this.parentNode.classList.remove('logo-img');this.remove()">${adminIcon('paw')}</div>`;
}

/** Devuelve un <svg> de trazo. cls: clases extra (ej. 'ico-sm'). */
function adminIcon(name, cls = '') {
  const p = _ADMIN_ICONS[name] || _ADMIN_ICONS.info;
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${p}</svg>`;
}

// ── Tema claro / oscuro ───────────────────────────────────────
// Sin elección guardada se sigue el sistema; el botón alterna y lo recuerda.
function _temaGuardado() { try { return localStorage.getItem('admin_theme'); } catch { return null; } }
function _temaActual() {
  const t = _temaGuardado();
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function aplicarTema(t) {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = _temaActual() === 'dark' ? '#16171a' : '#ffffff';
}
function alternarTema() {
  const nuevo = _temaActual() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('admin_theme', nuevo); } catch {}
  aplicarTema(nuevo);
  _pintarBotonTema();
}
function _pintarBotonTema() {
  const oscuro = _temaActual() === 'dark';
  document.querySelectorAll('[data-theme-btn]').forEach(b => {
    b.innerHTML = adminIcon(oscuro ? 'sun' : 'moon') + (b.dataset.themeBtn === 'label' ? `<span>${oscuro ? 'Tema claro' : 'Tema oscuro'}</span>` : '');
    b.setAttribute('aria-label', oscuro ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro');
  });
}
aplicarTema(_temaGuardado());

// ── Toast ─────────────────────────────────────────────────────
function toast(msg, tipo = 'success', ms = 3500) {
  let el = document.getElementById('__admin-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '__admin-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  const icons = { success: 'checkc', error: 'xc', warning: 'alert', info: 'info' };
  el.dataset.tipo = tipo;
  el.innerHTML = adminIcon(icons[tipo] || 'info') + '<span></span>';
  el.querySelector('span').textContent = String(msg ?? '');
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), ms);
}

function setNavActive(page) { document.querySelectorAll('.nav-item, .tab-item').forEach(el => { el.classList.toggle('active', el.dataset.page === page); }); }
const esc      = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
// Argumento de string para handlers inline: onclick="fn(${jsArg(x)})" — esc() solo no basta,
// el navegador decodifica &#39; a ' antes de ejecutar el JS del atributo.
const jsArg    = s => esc(JSON.stringify(String(s ?? '')));
const ADMIN_TZ = 'America/Lima';

function parseServerDate(iso) {
  if (!iso) return null;
  var s = String(iso);
  // Quitar Z — la fecha ya está en Lima, no convertir
  if (s.indexOf('Z') !== -1) return new Date(s.replace('Z', ''));
  if (s.indexOf('+') !== -1) return new Date(s);
  return new Date(s.replace(' ', 'T'));
}

const fDate    = function(iso) { var d = parseServerDate(iso); return d ? d.toLocaleDateString('es-PE', { day:'2-digit', month:'short', year:'numeric', timeZone: ADMIN_TZ }) : '—'; };
const fDateTime= function(iso) { var d = parseServerDate(iso); return d ? d.toLocaleString('es-PE', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', timeZone: ADMIN_TZ }) : '—'; };
const fNum     = n => Number(n||0).toLocaleString('es-PE');
const fMoney   = n => 'S/. '+Number(n||0).toFixed(2);
function badgePlan(plan) {
  const map = { basic: ['Básico', 'info'], pro: ['Profesional', 'violet'], enterprise: ['Clínica PRO', 'warn'] };
  const [label, tono] = map[plan] || [plan || '—', 'neutral'];
  const c = tono === 'neutral' ? 'background:var(--inset);color:var(--text-2)' : `background:var(--${tono}-bg);color:var(--${tono}-text)`;
  return `<span class="badge" style="${c}">${esc(label)}</span>`;
}
function badgeActivo(activo) {
  return activo
    ? '<span class="badge" style="background:var(--ok-bg);color:var(--ok-text)"><span class="dot"></span>Activa</span>'
    : '<span class="badge" style="background:var(--danger-bg);color:var(--danger-text)"><span class="dot"></span>Suspendida</span>';
}

// ── Navegación ────────────────────────────────────────────────
// Links del menú — agregar aquí nuevas páginas. `tab`: aparece en la barra inferior móvil.
const _ADMIN_NAV = [
  { href: 'index.html',    page: 'dashboard', icon: 'dashboard', label: 'Dashboard',          corto: 'Inicio',   tab: true },
  { href: 'clinicas.html', page: 'clinicas',  icon: 'clinic',    label: 'Clínicas',           corto: 'Clínicas', tab: true },
  { href: 'fe.html',       page: 'fe',        icon: 'receipt',   label: 'Facturación FE',     corto: 'FE',       tab: true },
  { href: 'wa.html',       page: 'wa',        icon: 'chat',      label: 'WhatsApp',           corto: 'WhatsApp', tab: true },
  { href: 'logs.html',     page: 'logs',      icon: 'logs',      label: 'Logs de auditoría',  corto: 'Logs'   },
  { href: 'backup.html',   page: 'backup',    icon: 'backup',    label: 'Backups',            corto: 'Backups' },
];

/**
 * Renderiza el armazón: sidebar (#sidebar), barra superior y barra inferior móviles.
 * Llamar con la página activa: renderSidebar('dashboard')
 */
function renderSidebar(paginaActiva) {
  if (!document.querySelector('link[rel="icon"]')) {
    const favicon = document.createElement('link');
    favicon.rel  = 'icon';
    favicon.href = 'logo.jpg';
    document.head.appendChild(favicon);
  }
  const admin   = getAdmin();
  const nombre  = admin?.nombre || admin?.email || 'Admin';
  const inicial = esc(nombre.trim().charAt(0).toUpperCase() || 'A');
  const actual  = _ADMIN_NAV.find(i => i.page === paginaActiva);

  const link = item => `
    <a href="${item.href}" class="nav-item${paginaActiva === item.page ? ' active' : ''}" data-page="${item.page}"${paginaActiva === item.page ? ' aria-current="page"' : ''}>
      ${adminIcon(item.icon)}<span>${item.label}</span>
    </a>`;

  const sidebarEl = document.getElementById('sidebar');
  if (sidebarEl) {
    sidebarEl.setAttribute('aria-label', 'Navegación principal');
    sidebarEl.innerHTML = `
      <div class="sb-brand">
        ${_logoHtml()}
        <div><div class="sb-title">VetClinic</div><div class="sb-sub">Panel de plataforma</div></div>
        <button class="btn-ghost btn-icon sb-close" onclick="adminDrawer(false)" aria-label="Cerrar menú">${adminIcon('x')}</button>
      </div>
      <nav class="sb-nav">
        <div class="sb-section">General</div>
        ${_ADMIN_NAV.slice(0, 2).map(link).join('')}
        <div class="sb-section">Servicios</div>
        ${_ADMIN_NAV.slice(2, 4).map(link).join('')}
        <div class="sb-section">Sistema</div>
        ${_ADMIN_NAV.slice(4).map(link).join('')}
      </nav>
      <div class="sb-foot">
        <div class="sb-user">
          <div class="sb-avatar">${inicial}</div>
          <div style="min-width:0">
            <div class="sb-user-name">${esc(nombre)}</div>
            <div class="sb-user-role">Super admin</div>
          </div>
        </div>
        <div class="sb-actions">
          <button class="btn-ghost" data-theme-btn="label" onclick="alternarTema()"></button>
          <button class="btn-ghost btn-icon" onclick="cerrarSesion()" aria-label="Cerrar sesión" title="Cerrar sesión">${adminIcon('logout')}</button>
        </div>
      </div>`;
  }

  // Barra superior, overlay del cajón y barra inferior (visibles solo en móvil por CSS)
  if (!document.querySelector('.topbar')) {
    document.body.insertAdjacentHTML('afterbegin', `
      <header class="topbar">
        ${_logoHtml()}
        <div class="topbar-title">${esc(actual?.label || 'VetClinic')}</div>
        <button class="btn-ghost btn-icon" data-theme-btn onclick="alternarTema()"></button>
      </header>
      <div class="drawer-overlay" onclick="adminDrawer(false)"></div>`);
    const tabs = _ADMIN_NAV.filter(i => i.tab);
    const enMas = !tabs.some(i => i.page === paginaActiva);
    document.body.insertAdjacentHTML('beforeend', `
      <nav class="tabbar" aria-label="Navegación">
        ${tabs.map(i => `
          <a href="${i.href}" class="tab-item${paginaActiva === i.page ? ' active' : ''}" data-page="${i.page}"${paginaActiva === i.page ? ' aria-current="page"' : ''}>
            ${adminIcon(i.icon)}<span>${i.corto}</span>
          </a>`).join('')}
        <button class="tab-item${enMas ? ' active' : ''}" onclick="adminDrawer(true)" aria-label="Más opciones">
          ${adminIcon('menu')}<span>Más</span>
        </button>
      </nav>`);
  }
  _pintarBotonTema();
}

function adminDrawer(abrir) {
  const sb = document.getElementById('sidebar');
  const ov = document.querySelector('.drawer-overlay');
  if (!sb) return;
  const open = abrir === undefined ? !sb.classList.contains('open') : abrir;
  sb.classList.toggle('open', open);
  if (ov) ov.classList.toggle('show', open);
  document.body.style.overflow = open ? 'hidden' : '';
}
// Compatibilidad: algunas páginas aún llaman toggleSidebar()
function toggleSidebar() { adminDrawer(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') adminDrawer(false); });

// ── App instalable (PWA) ──────────────────────────────────────
if ('serviceWorker' in navigator && !_adminIsLocal) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
