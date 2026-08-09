/**
 * VetClinic SaaS — Admin Shared JS
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

function toast(msg, tipo = 'success', ms = 3500) {
  let el = document.getElementById('__admin-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '__admin-toast';
    el.style.cssText = `position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;padding:.85rem 1.25rem;border-radius:.85rem;font-size:.84rem;font-weight:600;font-family:'Inter',sans-serif;box-shadow:0 20px 40px rgba(0,0,0,.4);display:flex;align-items:center;gap:.6rem;transition:all .3s;opacity:0;pointer-events:none;max-width:360px`;
    document.body.appendChild(el);
  }
  const colors = { success:{bg:'#052e16',color:'#4ade80',border:'#166534'}, error:{bg:'#450a0a',color:'#f87171',border:'#7f1d1d'}, warning:{bg:'#431407',color:'#fb923c',border:'#9a3412'}, info:{bg:'#0c1a3a',color:'#93c5fd',border:'#1e40af'} };
  const c = colors[tipo] || colors.info;
  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  el.style.background = c.bg; el.style.color = c.color; el.style.border = `1px solid ${c.border}`;
  el.innerHTML = `${icons[tipo]} ${msg}`; el.style.opacity = '1'; el.style.pointerEvents = 'auto';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.opacity = '0'; el.style.pointerEvents = 'none'; }, ms);
}

function setNavActive(page) { document.querySelectorAll('.nav-item').forEach(el => { el.classList.toggle('active', el.dataset.page === page); }); }
const esc      = s => String(s ?? '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
function badgePlan(plan) { const map = { basic:{label:'Basic',bg:'#1e3a5f',color:'#93c5fd'}, pro:{label:'Pro',bg:'#3b0764',color:'#d8b4fe'}, enterprise:{label:'Enterprise',bg:'#451a03',color:'#fed7aa'} }; const p = map[plan] || {label:plan,bg:'#1e293b',color:'#94a3b8'}; return `<span style="background:${p.bg};color:${p.color};font-size:.65rem;font-weight:700;padding:.2rem .55rem;border-radius:999px">${p.label}</span>`; }
function badgeActivo(activo) { return activo ? '<span style="background:#052e16;color:#4ade80;border:1px solid #166534;font-size:.68rem;font-weight:700;padding:.2rem .55rem;border-radius:999px">✅ Activo</span>' : '<span style="background:#450a0a;color:#f87171;border:1px solid #7f1d1d;font-size:.68rem;font-weight:700;padding:.2rem .55rem;border-radius:999px">❌ Inactivo</span>'; }

// ── Sidebar dinámico ──────────────────────────────────────────
// Links del menú — agregar aquí nuevas páginas
const _ADMIN_NAV = [
  { href: 'index.html',    page: 'dashboard', icon: '📊', label: 'Dashboard'             },
  { href: 'clinicas.html', page: 'clinicas',  icon: '🏥', label: 'Clínicas'              },
  { href: 'logs.html',     page: 'logs',      icon: '📋', label: 'Logs de auditoría'     },
  { href: 'backup.html',   page: 'backup',    icon: '💾', label: 'Backups'               },
  { href: 'fe.html',       page: 'fe',        icon: '⚡', label: 'Facturación FE'        },
  { href: 'wa.html',       page: 'wa',        icon: '💬', label: 'WhatsApp'              },
];

/**
 * Renderiza el sidebar completo en el elemento #sidebar
 * Llamar con la página activa: renderSidebar('dashboard')
 */
function renderSidebar(paginaActiva) {
  // Favicon dinámico para el panel admin
  if (!document.querySelector('link[rel="icon"]')) {
    const favicon = document.createElement('link');
    favicon.rel  = 'icon';
    favicon.href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🐾</text></svg>";
    document.head.appendChild(favicon);
  }
  const admin = getAdmin();
  const nombre  = admin?.nombre || admin?.email || 'Admin';
  const inicial = nombre.charAt(0).toUpperCase();

  const navLinks = _ADMIN_NAV.map(item => `
    <a href="${item.href}" class="nav-item${paginaActiva === item.page ? ' active' : ''}" data-page="${item.page}">
      ${item.icon} ${item.label}
    </a>`).join('');

  const html = `
    <div style="padding:1.25rem 1.2rem;border-bottom:1px solid #334155;display:flex;align-items:center;gap:.75rem">
      <div style="width:38px;height:38px;background:linear-gradient(135deg,#6366f1,#4f46e5);border-radius:.75rem;display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0">🐾</div>
      <div style="flex:1">
        <p style="font-weight:800;font-size:.92rem;color:#f1f5f9">VetClinic</p>
        <p style="font-size:.6rem;color:#475569;text-transform:uppercase;letter-spacing:.12em">SaaS Admin</p>
      </div>
      <button onclick="toggleSidebar()" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:1.1rem;display:none" id="btn-close-sb">✕</button>
    </div>
    <nav style="padding:.75rem;flex:1;overflow-y:auto">
      <p style="font-size:.6rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.12em;padding:.5rem .6rem;margin-bottom:.25rem">Principal</p>
      ${navLinks}
    </nav>
    <div style="padding:1rem 1.2rem;border-top:1px solid #334155">
      <div style="display:flex;align-items:center;gap:.65rem;margin-bottom:.75rem">
        <div style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;font-weight:700;font-size:.85rem;display:flex;align-items:center;justify-content:center">${inicial}</div>
        <div>
          <p style="font-size:.82rem;font-weight:700;color:#f1f5f9">${nombre}</p>
          <p style="font-size:.65rem;color:#475569">Super Admin</p>
        </div>
      </div>
      <button onclick="cerrarSesion()" style="width:100%;background:#0f172a;border:1px solid #334155;color:#94a3b8;padding:.5rem;border-radius:.65rem;cursor:pointer;font-size:.78rem;font-family:inherit;font-weight:600">🚪 Cerrar sesión</button>
    </div>`;

  const sidebarEl = document.getElementById('sidebar');
  if (sidebarEl) sidebarEl.innerHTML = html;
}

function toggleSidebar() {
  const sb  = document.getElementById('sidebar');
  const ov  = document.getElementById('sidebar-overlay');
  const btn = document.getElementById('btn-close-sb');
  if (!sb) return;
  const open = sb.classList.toggle('open');
  if (ov)  ov.style.display  = open ? 'block' : 'none';
  if (btn) btn.style.display = open ? 'block' : 'none';
}