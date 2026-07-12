/**
 * VetClinic SaaS — Shared JS v5
 * Detecta automáticamente si es local o producción
 */

// ── URL del backend ───────────────────────────────────────────────
const _isLocal = window.location.hostname === 'localhost' ||
                 window.location.hostname.endsWith('.test') ||
                 window.location.hostname.endsWith('.local') ||
                 window.location.hostname === '127.0.0.1';

const _baseDomain = window.location.hostname.split('.').slice(-2).join('.');

const API_URL    = _isLocal
  ? 'http://localhost:4000'
  : `https://api.${_baseDomain}`;

const SOCKET_URL = API_URL;

// ── Aplicar favicon inmediatamente al cargar shared.js ────────────
// No espera al DOMContentLoaded — así el tab del navegador lo muestra antes
(async function aplicarFaviconInmediato() {
  try {
    const res = await fetch(`${API_URL}/api/v1/branding`, {
      headers: { 'X-Tenant-Host': window.location.hostname }
    });
    if (!res.ok) return;
    const b = (await res.json()).data;
    if (!b) return;

    const iconUrl = b.favicon_url || b.logo_url;
    if (iconUrl) {
      // Favicon
      let link = document.querySelector("link[rel~='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = iconUrl;
    }

    // Título del tab con nombre de clínica
    if (b.nombre_clinica && b.nombre_clinica !== 'VetClinic') {
      const title = document.querySelector('title');
      if (title) title.textContent = title.textContent.replace('VetClinic', b.nombre_clinica);
    }
  } catch {}
})();

// ── Auth Guard ───────────────────────────────────────────────────
function requireAuth() {
  const token = localStorage.getItem('vet_access');
  const user  = localStorage.getItem('vet_user');
  if (!token || !user) { window.location.href = 'login.html'; return null; }
  return JSON.parse(user);
}

function logout() {
  localStorage.clear();
  window.location.href = 'login.html';
}

// ── API Helper ───────────────────────────────────────────────────
// ── Loader global ────────────────────────────────────────────────
let _loaderCount = 0;
let _loaderTimer = null;

function showLoader() {
  _loaderCount++;
  if (_loaderCount === 1) {
    // Pequeño delay para no mostrar el loader en requests muy rápidos
    _loaderTimer = setTimeout(() => {
      let el = document.getElementById('__global-loader');
      if (!el) {
        el = document.createElement('div');
        el.id = '__global-loader';
        el.innerHTML = `
          <div style="position:fixed;inset:0;background:rgba(255,255,255,.6);
            backdrop-filter:blur(2px);z-index:99999;display:flex;
            align-items:center;justify-content:center;
            animation:loaderFadeIn .2s ease">
            <div style="background:#fff;border-radius:1.25rem;padding:1.5rem 2rem;
              box-shadow:0 20px 60px rgba(13,59,46,.15);
              display:flex;align-items:center;gap:1rem;
              border:1px solid rgba(16,185,129,.15)">
              <div style="width:28px;height:28px;border:3px solid #e8ede9;
                border-top-color:#10b981;border-radius:50%;
                animation:loaderSpin .7s linear infinite"></div>
              <span style="font-size:.88rem;font-weight:600;color:#1a2e28;
                font-family:'Inter',sans-serif">Procesando…</span>
            </div>
          </div>`;
        if (!document.getElementById('__loader-style')) {
          const s = document.createElement('style');
          s.id = '__loader-style';
          s.textContent = `
            @keyframes loaderSpin { to { transform:rotate(360deg) } }
            @keyframes loaderFadeIn { from{opacity:0} to{opacity:1} }
          `;
          document.head.appendChild(s);
        }
        document.body.appendChild(el);
      }
      el.style.display = 'block';
    }, 150); // solo mostrar si tarda más de 150ms
  }
}

function hideLoader() {
  _loaderCount = Math.max(0, _loaderCount - 1);
  if (_loaderCount === 0) {
    clearTimeout(_loaderTimer);
    const el = document.getElementById('__global-loader');
    if (el) el.style.display = 'none';
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const token   = localStorage.getItem('vet_access');
  const headers = {
    'Content-Type'  : 'application/json',
    'X-Tenant-Host' : window.location.hostname,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  showLoader();
  try {
    const res = await fetch(`${API_URL}/api/v1${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401) {
      const ok = await tryRefresh();
      if (!ok) { logout(); return null; }
      headers['Authorization'] = `Bearer ${localStorage.getItem('vet_access')}`;
      return await fetch(`${API_URL}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    }
    return res;
  } finally {
    hideLoader();
  }
}

async function tryRefresh() {
  try {
    const r = localStorage.getItem('vet_refresh');
    if (!r) return false;
    const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ refreshToken: r }),
    });
    if (!res.ok) return false;
    const d = await res.json();
    localStorage.setItem('vet_access',  d.accessToken);
    localStorage.setItem('vet_refresh', d.refreshToken);
    return true;
  } catch { return false; }
}

// ── Socket.io ────────────────────────────────────────────────────
let _socket = null;

function getSocket() {
  if (_socket) return _socket;
  const token = localStorage.getItem('vet_access');
  _socket = io(API_URL, {
    auth: { token },
    reconnection: true,
    reconnectionDelay: 2000,
  });
  // Forzar logout si el tenant es suspendido
  _socket.on(`tenant:suspendido:${window.location.hostname}`, (data) => {
    const motivo = data?.mensaje || 'La clínica ha sido suspendida.';
    localStorage.setItem('vet_suspension_msg', motivo);
    setTimeout(() => {
      localStorage.removeItem('vet_access');
      localStorage.removeItem('vet_refresh');
      localStorage.removeItem('vet_user');
      window.location.href = 'login.html';
    }, 1500);
    // Mostrar toast antes de redirigir
    toast(`🚫 ${motivo}`, 'danger', 1500);
  });

  _socket.on('connect',    () => updateWsIndicator(true));
  _socket.on('disconnect', () => updateWsIndicator(false));
  _socket.on('connect_error', (e) => { if (e.message === 'UNAUTHORIZED') logout(); });
  return _socket;
}

function updateWsIndicator(connected) {
  const dot   = document.getElementById('ws-dot');
  const label = document.getElementById('ws-label');
  if (!dot) return;
  dot.className = connected ? 'ws-dot-on' : 'ws-dot-off';
  if (label) label.textContent = connected ? 'En vivo' : 'Desconectado';
}

// ── Toast ────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 4500) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const icons = { info:'ℹ️', success:'✅', warning:'⚠️', danger:'❌' };
  const el = document.createElement('div');
  el.className = `vtoast vtoast-${type}`;
  el.innerHTML = `<span class="vtoast-icon">${icons[type]||icons.info}</span><span>${esc(msg)}</span>`;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('vtoast-out'); setTimeout(() => el.remove(), 300); }, duration);
}

// ── Notificaciones ───────────────────────────────────────────────
let notifCount = 0;

function addNotif({ tipo, titulo, mensaje }) {
  notifCount++;
  const badge = document.getElementById('notif-badge');
  if (badge) { badge.textContent = notifCount; badge.classList.remove('hidden'); }
  const list = document.getElementById('notif-list');
  if (!list) return;
  const placeholder = list.querySelector('[data-placeholder]');
  if (placeholder) placeholder.remove();
  const icons = { cita_nueva:'📅', stock_minimo:'⚠️', vacuna_recordatorio:'💉', sistema:'ℹ️' };
  const li = document.createElement('li');
  li.className = 'notif-item';
  li.innerHTML = `<span class="notif-emoji">${icons[tipo]||'ℹ️'}</span>
    <div class="notif-content">
      <p class="notif-title">${esc(titulo)}</p>
      <p class="notif-msg">${esc(mensaje)}</p>
      <p class="notif-time">Ahora</p>
    </div>`;
  list.prepend(li);
}

async function marcarTodasLeidas() {
  await api('/notificaciones/leer-todas', { method:'PATCH' });
  notifCount = 0;
  const badge = document.getElementById('notif-badge');
  if (badge) badge.classList.add('hidden');
  const list = document.getElementById('notif-list');
  if (list) list.innerHTML = '<li data-placeholder class="notif-empty"><span>🔔</span>Sin notificaciones nuevas</li>';
}

// ── User info ────────────────────────────────────────────────────
function renderUserInfo(user) {
  const nameEl   = document.getElementById('user-name');
  const rolEl    = document.getElementById('user-rol');
  const avatarEl = document.getElementById('user-avatar');
  if (nameEl)   nameEl.textContent   = user.nombre;
  if (rolEl)    rolEl.textContent    = user.rol;
  if (avatarEl) avatarEl.textContent = user.nombre.charAt(0).toUpperCase();
}

// ── Sidebar / Modal helpers ──────────────────────────────────────
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebar-overlay');
  const open = !sb.classList.contains('sidebar-closed');
  sb.classList.toggle('sidebar-closed', open);
  if (ov) ov.classList.toggle('hidden', open);
}

function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

function toggleNotifPanel() {
  document.getElementById('notif-panel')?.classList.toggle('hidden');
}

// ── Fecha helpers ────────────────────────────────────────────────
function fechaHoyInput() {
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
}

function fechaHoraAhoraInput() {
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// ── Utilities ────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function fDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-PE', { day:'2-digit', month:'short', year:'numeric' });
}

function fDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-PE', { dateStyle:'short', timeStyle:'short' });
}

function fTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-PE', { hour:'2-digit', minute:'2-digit' });
}

function badgeEstado(estado) {
  const map = { pendiente:'badge-pendiente', confirmada:'badge-confirmada', en_curso:'badge-encurso', completada:'badge-completada', cancelada:'badge-cancelada' };
  return `<span class="vbadge ${map[estado]||''}">${(estado||'').replace('_',' ')}</span>`;
}

function badgeEspecie(especie) {
  const icons = { perro:'🐕', gato:'🐈', ave:'🦜', reptil:'🦎', roedor:'🐹', otro:'🐾' };
  return icons[especie] || '🐾';
}

// ── Branding dinámico ─────────────────────────────────────────
let _branding  = null;
let _permisos  = null;

async function cargarBranding() {
  if (_branding) return _branding;
  try {
    const res = await fetch(`${API_URL}/api/v1/branding`, {
      headers: { 'X-Tenant-Host': window.location.hostname }
    });
    if (!res.ok) return null;
    _branding = (await res.json()).data;
    aplicarBranding(_branding);
    return _branding;
  } catch { return null; }
}

function aplicarBranding(b) {
  if (!b) return;
  const r = document.documentElement;

  // Sidebar background
  if (b.color_sidebar) {
    r.style.setProperty('--sidebar-bg',  b.color_sidebar);
    r.style.setProperty('--sidebar-bg2', ajustarColor(b.color_sidebar, -10));
  }

  // Colores primarios — solo cambiar si son diferentes al default
  if (b.color_primario && b.color_primario !== '#10b981') {
    r.style.setProperty('--brand-primary', b.color_primario);
    r.style.setProperty('--green-500',     b.color_primario);
    r.style.setProperty('--green-600',     ajustarColor(b.color_primario, -15));
    r.style.setProperty('--green-50',      hexToRgba(b.color_primario, 0.08));
  }

  if (b.color_acento && b.color_acento !== '#059669') {
    r.style.setProperty('--brand-accent', b.color_acento);
  }

  // Título del documento
  if (b.nombre_clinica) {
    const title = document.querySelector('title');
    if (title) {
      title.textContent = title.textContent.replace('VetClinic', b.nombre_clinica);
    }
    // Nombre en sidebar
    const nameEl = document.getElementById('sidebar-clinica-nombre');
    if (nameEl) nameEl.textContent = b.nombre_clinica;
  }

  // Logo en sidebar
  if (b.logo_url) {
    const logoImg  = document.getElementById('sidebar-logo-img');
    const logoIcon = document.getElementById('sidebar-logo-icon');
    if (logoImg) {
      logoImg.src = b.logo_url;
      logoImg.style.display = 'block';
      if (logoIcon) logoIcon.style.display = 'none';
    }
  }

  // Favicon
  if (b.favicon_url) {
    let link = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = b.favicon_url;
  }
}

// ── Permisos granulares ───────────────────────────────────────
async function cargarPermisos() {
  if (_permisos) return _permisos;
  try {
    const token = localStorage.getItem('vet_access');
    if (!token) return null;
    const res = await fetch(`${API_URL}/api/v1/branding/permisos`, {
      headers: {
        'Authorization' : `Bearer ${token}`,
        'X-Tenant-Host' : window.location.hostname,
      }
    });
    if (!res.ok) return null;
    _permisos = (await res.json()).data;
    return _permisos;
  } catch { return null; }
}

// Verificar si el usuario tiene un permiso específico
// Uso: puede('facturacion','crear')
function puede(modulo, permiso) {
  if (!_permisos) return true; // Si no cargaron, permitir todo
  const user = JSON.parse(localStorage.getItem('vet_user') || '{}');
  if (user.rol === 'admin') return true; // Admin siempre puede todo
  return _permisos?.[modulo]?.[permiso] === true;
}

// Helpers de color
function ajustarColor(hex, amount) {
  try {
    const num = parseInt(hex.replace('#',''), 16);
    const r = Math.min(255, Math.max(0, (num >> 16) + amount));
    const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + amount));
    const b = Math.min(255, Math.max(0, (num & 0xff) + amount));
    return '#' + ((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);
  } catch { return hex; }
}

function hexToRgba(hex, alpha) {
  try {
    const num = parseInt(hex.replace('#',''), 16);
    const r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  } catch { return hex; }
}

function getBranding() { return _branding; }
function vconfirm({ titulo = '¿Confirmas esta acción?', mensaje = '', labelOk = 'Confirmar', labelCancel = 'Cancelar', tipo = 'warning' } = {}) {
  return new Promise(resolve => {
    // Eliminar modal anterior si existe
    document.getElementById('__vconfirm')?.remove();

    const colors = {
      warning : { bg:'#fffbeb', border:'#fde68a', icon:'⚠️',  btn:'background:#f59e0b;color:#fff' },
      danger  : { bg:'#fff1f2', border:'#fecdd3', icon:'🚨',  btn:'background:#e11d48;color:#fff' },
      info    : { bg:'#eff6ff', border:'#bfdbfe', icon:'ℹ️',  btn:'background:#1d4ed8;color:#fff' },
      success : { bg:'#f0fdf4', border:'#bbf7d0', icon:'✅',  btn:'background:#15803d;color:#fff' },
    };
    const c = colors[tipo] || colors.warning;

    const overlay = document.createElement('div');
    overlay.id = '__vconfirm';
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;
      display:flex;align-items:center;justify-content:center;padding:1rem;
      animation:fadeIn .15s ease`;

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:1.25rem;box-shadow:0 24px 64px rgba(0,0,0,.15);
        max-width:420px;width:100%;overflow:hidden;animation:slideUp .2s ease">
        <div style="background:${c.bg};border-bottom:1px solid ${c.border};
          padding:1.25rem 1.5rem;display:flex;align-items:center;gap:.85rem">
          <span style="font-size:1.5rem">${c.icon}</span>
          <p style="font-weight:700;font-size:.95rem;margin:0;color:#1a2e28">${titulo}</p>
        </div>
        ${mensaje ? `<div style="padding:1.1rem 1.5rem;font-size:.85rem;color:#4b5563;line-height:1.6">${mensaje}</div>` : ''}
        <div style="padding:1rem 1.5rem;display:flex;justify-content:flex-end;gap:.6rem;
          border-top:1px solid #f3f4f6">
          <button id="__vconfirm-cancel" style="padding:.55rem 1.2rem;border:1.5px solid #e5e7eb;
            background:#fff;border-radius:.75rem;font-size:.84rem;font-weight:600;cursor:pointer;
            color:#374151;font-family:inherit;transition:all .15s">
            ${labelCancel}
          </button>
          <button id="__vconfirm-ok" style="padding:.55rem 1.4rem;border:none;border-radius:.75rem;
            font-size:.84rem;font-weight:700;cursor:pointer;font-family:inherit;
            ${c.btn};transition:all .15s">
            ${labelOk}
          </button>
        </div>
      </div>`;

    // Estilos de animación
    if (!document.getElementById('__vconfirm-style')) {
      const style = document.createElement('style');
      style.id = '__vconfirm-style';
      style.textContent = `
        @keyframes fadeIn  { from{opacity:0} to{opacity:1} }
        @keyframes slideUp { from{transform:translateY(12px);opacity:0} to{transform:translateY(0);opacity:1} }
        #__vconfirm-cancel:hover { background:#f9fafb!important; }
        #__vconfirm-ok:hover { opacity:.9; transform:translateY(-1px); }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(overlay);

    const cleanup = (result) => {
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity .15s';
      setTimeout(() => overlay.remove(), 150);
      resolve(result);
    };

    document.getElementById('__vconfirm-ok').onclick     = () => cleanup(true);
    document.getElementById('__vconfirm-cancel').onclick = () => cleanup(false);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { cleanup(false); document.removeEventListener('keydown', esc); }
      if (e.key === 'Enter')  { cleanup(true);  document.removeEventListener('keydown', esc); }
    });
  });
}

// ── Manejo centralizado de errores de API ─────────────────────────
function apiError(status, message) {
  if (status === 403) {
    toast('🔒 No tienes permisos para realizar esta acción.', 'warning', 5000);
  } else if (status === 401) {
    toast('⏱️ Tu sesión ha expirado. Vuelve a iniciar sesión.', 'danger', 5000);
    setTimeout(() => { localStorage.clear(); window.location.href = 'login.html'; }, 2000);
  } else if (status === 404) {
    toast('🔍 Registro no encontrado.', 'warning');
  } else if (status === 422) {
    toast(`⚠️ ${message || 'Datos inválidos.'}`, 'warning');
  } else if (status >= 500) {
    toast('🔧 Error del servidor. Intenta de nuevo.', 'danger');
  } else {
    toast(message || 'Ocurrió un error inesperado.', 'danger');
  }
}