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
      let link = document.querySelector("link[rel~='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = iconUrl;
    }

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

// ── Loader global ────────────────────────────────────────────────
let _loaderCount = 0;
let _loaderTimer = null;

function showLoader() {
  _loaderCount++;
  if (_loaderCount === 1) {
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
    }, 150);
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


// ── Selector de sede reutilizable (solo para admin) ──────────────
// containerId: id del div donde insertar el selector
// onChange: callback(sedeId) cuando cambia la selección
async function initSelectorSede(containerId, onChange, opciones = {}) {
  var user = getUser();
  if (user.rol !== 'admin') return; // solo admin ve el selector

  var cont = document.getElementById(containerId);
  if (!cont) return;

  // Cargar sedes disponibles
  try {
    var res   = await api('/reportes/sedes');
    if (!res?.ok) return;
    var sedes = (await res.json()).data || [];
    if (sedes.length <= 1) return; // con 1 sede no tiene sentido el selector

    var label  = opciones.label !== undefined ? opciones.label : 'Sede:';
    var all    = opciones.labelTodas !== undefined ? opciones.labelTodas : '🏥 Todas las sedes';
    var size   = opciones.size || 'normal';
    var inline = opciones.inline !== false;

    var wrap = document.createElement('div');
    wrap.style.cssText = inline
      ? 'display:flex;align-items:center;gap:.5rem'
      : 'display:flex;flex-direction:column;gap:.25rem';

    if (label) {
      var lbl = document.createElement('label');
      lbl.textContent = label;
      lbl.style.cssText = 'font-size:.72rem;font-weight:700;color:var(--ink-soft);white-space:nowrap';
      wrap.appendChild(lbl);
    }

    var sel = document.createElement('select');
    sel.className = 'vinput';
    sel.style.cssText = size === 'small'
      ? 'font-size:.78rem;padding:.3rem .6rem;width:auto;min-width:160px'
      : 'width:auto;min-width:180px';
    sel.id = containerId + '-select';

    sel.innerHTML = '<option value="">' + all + '</option>' +
      sedes.map(function(s) {
        return '<option value="' + s.id + '">' + (s.nombre) + '</option>';
      }).join('');

    // Restaurar sede guardada en sessionStorage
    var guardada = sessionStorage.getItem('sede_activa_admin');
    if (guardada) {
      sel.value = guardada;
      setSedeActiva(guardada || null);
    }

    sel.onchange = function() {
      var val = sel.value || null;
      setSedeActiva(val);
      sessionStorage.setItem('sede_activa_admin', val || '');
      if (onChange) onChange(val);
    };

    wrap.appendChild(sel);
    cont.innerHTML = '';
    cont.appendChild(wrap);
    cont.style.display = 'block';
  } catch(e) { console.warn('Error cargando selector sede:', e); }
}

// ── Badge de sede para mostrar en cards/tablas ───────────────────
function badgeSede(sedeNombre, opts) {
  if (!sedeNombre) return '';
  opts = opts || {};
  var color = opts.color || '#0369a1';
  var bg    = opts.bg    || '#f0f9ff';
  var bdr   = opts.bdr   || '#bae6fd';
  return '<span style="font-size:.62rem;font-weight:700;background:' + bg + ';color:' + color +
    ';padding:.15rem .5rem;border-radius:999px;border:1px solid ' + bdr + ';white-space:nowrap">' +
    '🏥 ' + sedeNombre + '</span>';
}

// ── Sede seleccionada globalmente (admin puede cambiar) ──────────
var _sedeSeleccionadaGlobal = null; // null = todas las sedes (solo admin)

function getSedeActiva() {
  var user = JSON.parse(localStorage.getItem('vet_user') || '{}');
  // No-admin: siempre su sede del JWT
  if (user.rol !== 'admin') return user.sede_id || null;
  // Admin: la sede seleccionada en el selector (null = todas)
  return _sedeSeleccionadaGlobal;
}

function setSedeActiva(sedeId) {
  _sedeSeleccionadaGlobal = sedeId ? parseInt(sedeId) : null;
}

function getUser() {
  try { return JSON.parse(localStorage.getItem('vet_user') || '{}'); } catch { return {}; }
}

function isAdmin() {
  return getUser().rol === 'admin';
}

// ── API Helper ───────────────────────────────────────────────────
async function api(path, { method = 'GET', body } = {}) {
  const token   = localStorage.getItem('vet_access');
  const headers = {
    'Content-Type'  : 'application/json',
    'X-Tenant-Host' : window.location.hostname,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // Sede activa: del selector si es admin, del JWT si no lo es
  const sedeActiva = getSedeActiva();
  if (sedeActiva) headers['X-Sede-Id'] = String(sedeActiva);

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
  _socket.on(`tenant:suspendido:${window.location.hostname}`, (data) => {
    const motivo = data?.mensaje || 'La clínica ha sido suspendida.';
    localStorage.setItem('vet_suspension_msg', motivo);
    setTimeout(() => {
      localStorage.removeItem('vet_access');
      localStorage.removeItem('vet_refresh');
      localStorage.removeItem('vet_user');
      window.location.href = 'login.html';
    }, 1500);
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

// ── User info ─────────────────────────────────────────────────────
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

// ── Zona horaria dinámica del tenant ─────────────────────────────
function getTZ() {
  return _branding?.zona_horaria || 'America/Lima';
}

function getLocale() {
  const pais = _branding?.pais || 'Peru';
  const locales = {
    'Peru'      : 'es-PE',
    'Colombia'  : 'es-CO',
    'Mexico'    : 'es-MX',
    'Chile'     : 'es-CL',
    'Argentina' : 'es-AR',
    'Ecuador'   : 'es-EC',
    'Bolivia'   : 'es-BO',
    'Paraguay'  : 'es-PY',
    'Uruguay'   : 'es-UY',
    'Venezuela' : 'es-VE',
    'Panama'    : 'es-PA',
    'Guatemala' : 'es-GT',
  };
  return locales[pais] || 'es-PE';
}

function fDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(getLocale(), {
    day:'2-digit', month:'short', year:'numeric',
    timeZone: getTZ(),
  });
}

function fDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(getLocale(), {
    dateStyle:'short', timeStyle:'short',
    timeZone: getTZ(),
  });
}

function fTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(getLocale(), {
    hour:'2-digit', minute:'2-digit',
    timeZone: getTZ(),
  });
}

function badgeEstado(estado) {
  const map = { pendiente:'badge-pendiente', confirmada:'badge-confirmada', en_curso:'badge-encurso', completada:'badge-completada', cancelada:'badge-cancelada' };
  return `<span class="vbadge ${map[estado]||''}">${(estado||'').replace('_',' ')}</span>`;
}

function badgeEspecie(especie) {
  const icons = { perro:'🐕', gato:'🐈', ave:'🦜', reptil:'🦎', roedor:'🐹', otro:'🐾' };
  return icons[especie] || '🐾';
}

// ── Foto de perfil de la mascota ─────────────────────────────────
// Si la mascota tiene foto (m.foto_updated_at) devuelve un <img> que se carga solo
// con el token (contenedor privado). Si no tiene, devuelve el emoji de la especie.
// El <img> ocupa el 100% de su contenedor: el contenedor define tamaño y bordes
// (debe tener overflow:hidden).
var _mascotaFotoCache = {}; // 'id:version' → Promise<blobUrl|null>

function mascotaFotoHTML(m) {
  var emoji = badgeEspecie(m && m.especie);
  if (!m || !m.id || !m.foto_updated_at) return emoji;
  var v = encodeURIComponent(String(m.foto_updated_at));
  return '<img data-mfoto="' + m.id + '" data-mfv="' + v + '" data-emoji="' + emoji + '" alt="' + esc(m.nombre || 'foto') + '"' +
    ' style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;opacity:0;transition:opacity .25s"/>';
}

function _cargarFotoMascota(img) {
  img.setAttribute('data-mfoto-ok', '1');
  var id  = img.getAttribute('data-mfoto');
  var v   = img.getAttribute('data-mfv');
  var key = id + ':' + v;
  if (!_mascotaFotoCache[key]) {
    var headers = { 'X-Tenant-Host': window.location.hostname };
    var token = localStorage.getItem('vet_access');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    _mascotaFotoCache[key] = fetch(API_URL + '/api/v1/mascotas/' + id + '/foto?v=' + v, { headers: headers })
      .then(function(r) { return r.ok ? r.blob() : null; })
      .then(function(b) { return b ? URL.createObjectURL(b) : null; })
      .catch(function() { return null; });
  }
  _mascotaFotoCache[key].then(function(url) {
    if (url) {
      img.onload = function() { img.style.opacity = '1'; };
      img.src = url;
    } else {
      // No se pudo cargar → volver al emoji
      var span = document.createElement('span');
      span.textContent = img.getAttribute('data-emoji') || '🐾';
      if (img.parentNode) img.parentNode.replaceChild(span, img);
      delete _mascotaFotoCache[key];
    }
  });
}

function cargarFotosMascotas(root) {
  (root || document).querySelectorAll('img[data-mfoto]:not([data-mfoto-ok])').forEach(_cargarFotoMascota);
}

// Carga automática: cualquier <img data-mfoto> que aparezca en la página se carga solo
(function() {
  var pendiente = false;
  function programar() {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(function() { pendiente = false; cargarFotosMascotas(); });
  }
  function iniciar() {
    cargarFotosMascotas();
    new MutationObserver(programar).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();

/** Reduce la foto en el navegador (máx. 600 px, JPG) antes de subirla. */
function comprimirFotoMascota(file, maxLado, calidad) {
  maxLado = maxLado || 600;
  calidad = calidad || 0.85;
  return new Promise(function(resolve, reject) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function() {
      var esc_ = Math.min(1, maxLado / Math.max(img.width, img.height));
      var w = Math.round(img.width * esc_), h = Math.round(img.height * esc_);
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';            // fondo blanco para PNG con transparencia
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(function(blob) {
        if (blob) resolve(blob); else reject(new Error('No se pudo procesar la imagen.'));
      }, 'image/jpeg', calidad);
    };
    img.onerror = function() { URL.revokeObjectURL(url); reject(new Error('El archivo no es una imagen válida.')); };
    img.src = url;
  });
}

/** Sube (o reemplaza) la foto de la mascota. Devuelve { ok, foto_updated_at, message } */
async function subirFotoMascota(mascotaId, file) {
  if (['image/jpeg', 'image/png', 'image/webp'].indexOf(file.type) === -1) {
    return { ok: false, message: 'Solo se permiten imágenes JPG, PNG o WEBP.' };
  }
  showLoader();
  try {
    var blob = await comprimirFotoMascota(file);
    var fd = new FormData();
    fd.append('foto', blob, 'foto.jpg');
    var headers = { 'X-Tenant-Host': window.location.hostname };
    var token = localStorage.getItem('vet_access');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    var sede = getSedeActiva();
    if (sede) headers['X-Sede-Id'] = String(sede);
    var res = await fetch(API_URL + '/api/v1/mascotas/' + mascotaId + '/foto', { method: 'POST', headers: headers, body: fd });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, foto_updated_at: data.data && data.data.foto_updated_at, message: data.message || '' };
  } catch (e) {
    return { ok: false, message: e.message || 'Error al subir la foto.' };
  } finally {
    hideLoader();
  }
}

/** Quita la foto de la mascota (vuelve el emoji). Devuelve true/false */
async function eliminarFotoMascota(mascotaId) {
  try {
    var res = await api('/mascotas/' + mascotaId + '/foto', { method: 'DELETE' });
    return !!(res && res.ok);
  } catch (e) { return false; }
}

// ── Branding dinámico ─────────────────────────────────────────────
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

  if (b.color_sidebar) {
    r.style.setProperty('--sidebar-bg',  b.color_sidebar);
    r.style.setProperty('--sidebar-bg2', ajustarColor(b.color_sidebar, -10));
  }

  if (b.color_primario && b.color_primario !== '#10b981') {
    r.style.setProperty('--brand-primary', b.color_primario);
    r.style.setProperty('--green-500',     b.color_primario);
    r.style.setProperty('--green-600',     ajustarColor(b.color_primario, -15));
    r.style.setProperty('--green-50',      hexToRgba(b.color_primario, 0.08));
  }

  if (b.color_acento && b.color_acento !== '#059669') {
    r.style.setProperty('--brand-accent', b.color_acento);
  }

  if (b.nombre_clinica) {
    const title = document.querySelector('title');
    if (title) {
      title.textContent = title.textContent.replace('VetClinic', b.nombre_clinica);
    }
    const nameEl = document.getElementById('sidebar-clinica-nombre');
    if (nameEl) nameEl.textContent = b.nombre_clinica;
  }

  if (b.logo_url) {
    const logoImg  = document.getElementById('sidebar-logo-img');
    const logoIcon = document.getElementById('sidebar-logo-icon');
    if (logoImg) {
      logoImg.src = b.logo_url;
      logoImg.style.display = 'block';
      if (logoIcon) logoIcon.style.display = 'none';
    }
  }

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

// ── Permisos granulares ───────────────────────────────────────────
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

function puede(modulo, permiso) {
  if (!_permisos) return true;
  const user = JSON.parse(localStorage.getItem('vet_user') || '{}');
  if (user.rol === 'admin') return true;
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