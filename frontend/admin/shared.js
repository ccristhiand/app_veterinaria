/**
 * VetClinic SaaS — Admin Shared JS
 * Funciones compartidas entre todas las páginas del panel admin
 */

const _adminIsLocal = window.location.hostname === 'localhost' ||
                      window.location.hostname.endsWith('.test') ||
                      window.location.hostname === '127.0.0.1';
const _adminBase    = window.location.hostname.split('.').slice(-2).join('.');
const ADMIN_API     = _adminIsLocal
  ? 'http://localhost:4000/admin/api'
  : `https://api.${_adminBase}/admin/api`;

// ── Auth ──────────────────────────────────────────────────────
function getToken()  { return localStorage.getItem('admin_token'); }
function getAdmin()  { return JSON.parse(localStorage.getItem('admin_user') || 'null'); }
function isLoggedIn(){ return !!getToken(); }

function requireAuth() {
  if (!isLoggedIn()) { window.location.href = 'login.html'; return false; }
  return true;
}

function cerrarSesion() {
  localStorage.removeItem('admin_token');
  localStorage.removeItem('admin_user');
  window.location.href = 'login.html';
}

// ── Fetch helper ──────────────────────────────────────────────
async function adminFetch(path, opts = {}) {
  const res = await fetch(`${ADMIN_API}${path}`, {
    ...opts,
    headers: {
      'Content-Type' : 'application/json',
      'Authorization': `Bearer ${getToken()}`,
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { cerrarSesion(); return null; }
  return res;
}

// ── Toast ─────────────────────────────────────────────────────
function toast(msg, tipo = 'success', ms = 3500) {
  let el = document.getElementById('__admin-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '__admin-toast';
    el.style.cssText = `position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;
      padding:.85rem 1.25rem;border-radius:.85rem;font-size:.84rem;font-weight:600;
      font-family:'Inter',sans-serif;box-shadow:0 20px 40px rgba(0,0,0,.4);
      display:flex;align-items:center;gap:.6rem;transition:all .3s;opacity:0;
      pointer-events:none;max-width:360px`;
    document.body.appendChild(el);
  }
  const colors = {
    success: { bg:'#052e16', color:'#4ade80', border:'#166534' },
    error  : { bg:'#450a0a', color:'#f87171', border:'#7f1d1d' },
    warning: { bg:'#431407', color:'#fb923c', border:'#9a3412' },
    info   : { bg:'#0c1a3a', color:'#93c5fd', border:'#1e40af' },
  };
  const c = colors[tipo] || colors.info;
  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  el.style.background   = c.bg;
  el.style.color        = c.color;
  el.style.border       = `1px solid ${c.border}`;
  el.innerHTML          = `${icons[tipo]} ${msg}`;
  el.style.opacity      = '1';
  el.style.pointerEvents = 'auto';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.opacity = '0'; el.style.pointerEvents = 'none'; }, ms);
}

// ── Sidebar activo ────────────────────────────────────────────
function setNavActive(page) {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });
}

// ── Formatters ────────────────────────────────────────────────
const esc     = s => String(s ?? '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fDate   = iso => iso ? new Date(iso).toLocaleDateString('es-PE', { day:'2-digit', month:'short', year:'numeric' }) : '—';
const fNum    = n => Number(n||0).toLocaleString('es-PE');
const fMoney  = n => 'S/. '+Number(n||0).toFixed(2);

// ── Badge plan ────────────────────────────────────────────────
function badgePlan(plan) {
  const map = {
    basic     : { label:'Basic',      bg:'#1e3a5f', color:'#93c5fd' },
    pro       : { label:'Pro',        bg:'#3b0764', color:'#d8b4fe' },
    enterprise: { label:'Enterprise', bg:'#451a03', color:'#fed7aa' },
  };
  const p = map[plan] || { label: plan, bg:'#1e293b', color:'#94a3b8' };
  return `<span style="background:${p.bg};color:${p.color};font-size:.65rem;font-weight:700;
    padding:.2rem .55rem;border-radius:999px">${p.label}</span>`;
}

// ── Badge activo ──────────────────────────────────────────────
function badgeActivo(activo) {
  return activo
    ? '<span style="background:#052e16;color:#4ade80;border:1px solid #166534;font-size:.68rem;font-weight:700;padding:.2rem .55rem;border-radius:999px">✅ Activo</span>'
    : '<span style="background:#450a0a;color:#f87171;border:1px solid #7f1d1d;font-size:.68rem;font-weight:700;padding:.2rem .55rem;border-radius:999px">❌ Inactivo</span>';
}