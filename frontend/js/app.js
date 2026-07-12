/**
 * VetClinic — Frontend App
 * Maneja: Auth JWT, Socket.io, navegación, CRUD básico
 */

// ── Configuración ─────────────────────────────────────────────────────────────
const _isLocalApp = window.location.hostname === 'localhost' ||
                    window.location.hostname.endsWith('.test') ||
                    window.location.hostname.endsWith('.local') ||
                    window.location.hostname === '127.0.0.1';
const _baseDomainApp = window.location.hostname.split('.').slice(-2).join('.');
const API_URL = _isLocalApp
  ? 'http://localhost:4000/api/v1'
  : `https://api.${_baseDomainApp}/api/v1`;

// ── Estado global ──────────────────────────────────────────────────────────────
const State = {
  accessToken : localStorage.getItem('vet_access')  || null,
  refreshToken: localStorage.getItem('vet_refresh') || null,
  user        : JSON.parse(localStorage.getItem('vet_user') || 'null'),
  socket      : null,
  notifCount  : 0,
};

// ══════════════════════════════════════════════════════════════════════════════
// API HELPER
// ══════════════════════════════════════════════════════════════════════════════
async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {
    'Content-Type' : 'application/json',
    'X-Tenant-Host': window.location.hostname,
  };
  if (auth && State.accessToken) headers['Authorization'] = `Bearer ${State.accessToken}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && State.refreshToken) {
    const ok = await refreshTokens();
    if (ok) {
      headers['Authorization'] = `Bearer ${State.accessToken}`;
      return fetch(`${API_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } else {
      logout();
      return;
    }
  }
  return res;
}

async function refreshTokens() {
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Host': window.location.hostname },
      body   : JSON.stringify({ refreshToken: State.refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

function setTokens(access, refresh) {
  State.accessToken  = access;
  State.refreshToken = refresh;
  localStorage.setItem('vet_access',  access);
  localStorage.setItem('vet_refresh', refresh);
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════════════════════
async function doLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  const btn      = document.getElementById('login-btn');
  errEl.classList.add('hidden');
  btn.disabled    = true;
  btn.textContent = 'Ingresando…';
  try {
    const res  = await api('/auth/login', { method: 'POST', body: { email, password }, auth: false });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.message || 'Error al iniciar sesión.';
      errEl.classList.remove('hidden');
      return;
    }
    setTokens(data.accessToken, data.refreshToken);
    State.user = data.user;
    localStorage.setItem('vet_user', JSON.stringify(data.user));
    initApp();
  } catch (e) {
    errEl.textContent = 'No se pudo conectar al servidor.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Iniciar Sesión';
  }
}

function logout() {
  State.accessToken = State.refreshToken = State.user = null;
  localStorage.removeItem('vet_access');
  localStorage.removeItem('vet_refresh');
  localStorage.removeItem('vet_user');
  if (State.socket) State.socket.disconnect();
  showOnly('login');
}

// ══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO — TIEMPO REAL
// ══════════════════════════════════════════════════════════════════════════════
function connectSocket() {
  if (State.socket?.connected) return;

  const socketUrl = _isLocalApp
    ? 'http://localhost:4000'
    : `https://api.${_baseDomainApp}`;

  State.socket = io(socketUrl, {
    auth             : { token: State.accessToken },
    extraHeaders     : { 'X-Tenant-Host': window.location.hostname },
    reconnection     : true,
    reconnectionDelay: 2000,
    reconnectionAttempts: 10,
  });

  const indicator = document.getElementById('ws-indicator');
  const label     = document.getElementById('ws-label');

  State.socket.on('connect', () => {
    indicator.className = 'w-2 h-2 rounded-full bg-success notif-dot';
    label.textContent   = 'En vivo';
    label.className     = 'hidden sm:inline text-success';
  });

  State.socket.on('disconnect', (reason) => {
    indicator.className = 'w-2 h-2 rounded-full bg-danger';
    label.textContent   = 'Desconectado';
    label.className     = 'hidden sm:inline text-gray-400';
  });

  State.socket.on('cita:nueva', (msg) => {
    const { payload } = msg;
    toast(`Nueva cita: ${payload.mascota_nombre} — ${formatFecha(payload.fecha_hora)}`, 'info', 6000);
    agregarFilaCita(payload);
    incrementarBadgeCitas();
    agregarNotifPanel({
      tipo   : 'cita_nueva',
      titulo : `Nueva cita: ${payload.mascota_nombre}`,
      mensaje: `${payload.motivo} — ${formatFecha(payload.fecha_hora)}`,
    });
  });

  State.socket.on('cita:actualizada', (msg) => {
    actualizarEstadoEnTabla(msg.id, msg.estado);
    toast(`Cita #${msg.id} → ${msg.estado}`, 'success');
  });

  State.socket.on('notif:stock_minimo', (msg) => {
    const { payload } = msg;
    toast(`⚠️ Stock bajo: ${payload.nombre} (${payload.cantidad} ${payload.unidad})`, 'warning', 8000);
    agregarNotifPanel({
      tipo   : 'stock_minimo',
      titulo : `Stock bajo: ${payload.nombre}`,
      mensaje: `Quedan ${payload.cantidad} ${payload.unidad}. Mínimo: ${payload.stock_minimo}.`,
    });
  });

  State.socket.on('notif:vacuna_recordatorio', (msg) => {
    const { payload } = msg;
    toast(`💉 Vacuna pendiente: ${payload.nombre} — ${payload.mascota_nombre}`, 'info', 7000);
    agregarNotifPanel({
      tipo   : 'vacuna_recordatorio',
      titulo : `Vacuna: ${payload.nombre}`,
      mensaje: `Mascota: ${payload.mascota_nombre}`,
    });
  });

  State.socket.on('connect_error', (err) => {
    if (err.message === 'UNAUTHORIZED') logout();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// UI — SECCIONES
// ══════════════════════════════════════════════════════════════════════════════
function showOnly(section) {
  document.querySelectorAll('[id^="section-"]').forEach((el) => el.classList.add('hidden'));
  const target = document.getElementById(`section-${section}`);
  if (target) target.classList.remove('hidden');
  document.querySelectorAll('.nav-link').forEach((a) => {
    a.classList.toggle(
      'bg-primary-light text-primary font-semibold',
      a.dataset.section === section,
    );
  });
  document.getElementById('page-title').textContent = {
    dashboard    : 'Dashboard',
    citas        : 'Gestión de Citas',
    propietarios : 'Propietarios',
    mascotas     : 'Mascotas',
    historia     : 'Historia Clínica',
    inventario   : 'Inventario',
  }[section] || '';
}

document.querySelectorAll('.nav-link').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const sec = a.dataset.section;
    showOnly(sec);
    closeSidebar();
    if (sec === 'dashboard')    cargarDashboard();
    if (sec === 'citas')        cargarCitas();
    if (sec === 'propietarios') cargarPropietarios();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
async function cargarDashboard() {
  const hoy = new Date().toISOString().split('T')[0];
  try {
    const [resCitas, resInv] = await Promise.all([
      api(`/citas?fecha=${hoy}&limit=50`),
      api('/inventario'),
    ]);
    if (resCitas?.ok) {
      const d = await resCitas.json();
      document.getElementById('stat-citas').textContent = d.data.length;
      renderCitasHoy(d.data);
    }
    if (resInv?.ok) {
      const d = await resInv.json();
      const bajos = d.data.filter((i) => i.bajo_stock).length;
      document.getElementById('stat-stock').textContent = bajos;
    }
  } catch (e) {
    console.error(e);
  }
}

function renderCitasHoy(citas) {
  const tbody = document.getElementById('citas-hoy-body');
  if (!citas.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="px-5 py-8 text-center text-gray-400">Sin citas para hoy</td></tr>';
    return;
  }
  tbody.innerHTML = citas.map((c) => `
    <tr class="hover:bg-gray-50 transition" data-cita-id="${c.id}">
      <td class="px-5 py-3 text-gray-600">${hora(c.fecha_hora)}</td>
      <td class="px-5 py-3 font-medium text-gray-800">${esc(c.mascota_nombre)} <span class="text-gray-400 text-xs">${esc(c.especie || '')}</span></td>
      <td class="px-5 py-3 text-gray-600 hidden sm:table-cell">${esc(c.propietario_nombre || '—')}</td>
      <td class="px-5 py-3 text-gray-600 hidden md:table-cell">${esc(c.veterinario_nombre || '—')}</td>
      <td class="px-5 py-3">${badgeEstado(c.estado)}</td>
    </tr>
  `).join('');
}

function agregarFilaCita(cita) {
  const tbody = document.getElementById('citas-hoy-body');
  if (!tbody) return;
  if (tbody.querySelector('td[colspan]')) tbody.innerHTML = '';
  const tr = document.createElement('tr');
  tr.className   = 'hover:bg-gray-50 transition bg-blue-50';
  tr.dataset.citaId = cita.id;
  tr.innerHTML = `
    <td class="px-5 py-3 text-gray-600">${hora(cita.fecha_hora)}</td>
    <td class="px-5 py-3 font-medium text-gray-800">${esc(cita.mascota_nombre)}</td>
    <td class="px-5 py-3 text-gray-600 hidden sm:table-cell">${esc(cita.propietario_nombre || '—')}</td>
    <td class="px-5 py-3 text-gray-600 hidden md:table-cell">${esc(cita.veterinario_nombre || '—')}</td>
    <td class="px-5 py-3">${badgeEstado(cita.estado)}</td>
  `;
  tbody.prepend(tr);
  setTimeout(() => tr.classList.remove('bg-blue-50'), 3000);
}

function actualizarEstadoEnTabla(citaId, estado) {
  document.querySelectorAll(`[data-cita-id="${citaId}"] td:last-child`).forEach((td) => {
    td.innerHTML = badgeEstado(estado);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// CITAS
// ══════════════════════════════════════════════════════════════════════════════
async function cargarCitas() {
  const fecha  = document.getElementById('filter-fecha')?.value  || '';
  const estado = document.getElementById('filter-estado')?.value || '';
  let url = '/citas?limit=50';
  if (fecha)  url += `&fecha=${fecha}`;
  if (estado) url += `&estado=${estado}`;
  const tbody = document.getElementById('citas-body');
  tbody.innerHTML = '<tr><td colspan="6" class="px-5 py-8 text-center text-gray-400">Cargando…</td></tr>';
  try {
    const res  = await api(url);
    const data = await res.json();
    if (!data.data.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="px-5 py-8 text-center text-gray-400">Sin citas</td></tr>';
      return;
    }
    tbody.innerHTML = data.data.map((c) => `
      <tr class="hover:bg-gray-50" data-cita-id="${c.id}">
        <td class="px-5 py-3 text-gray-400 text-xs">#${c.id}</td>
        <td class="px-5 py-3 text-sm">${formatFecha(c.fecha_hora)}</td>
        <td class="px-5 py-3 font-medium">${esc(c.mascota_nombre)}</td>
        <td class="px-5 py-3 text-gray-600 hidden sm:table-cell">${esc(c.motivo)}</td>
        <td class="px-5 py-3">${badgeEstado(c.estado)}</td>
        <td class="px-5 py-3 text-gray-600 hidden md:table-cell">${esc(c.veterinario_nombre)}</td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6" class="px-5 py-8 text-center text-red-400">Error al cargar citas</td></tr>';
  }
}

async function guardarCita() {
  const payload = {
    mascota_id    : parseInt(document.getElementById('cita-mascota-id').value),
    veterinario_id: parseInt(document.getElementById('cita-vet-id').value),
    fecha_hora    : document.getElementById('cita-fecha').value,
    duracion_min  : parseInt(document.getElementById('cita-duracion').value) || 30,
    motivo        : document.getElementById('cita-motivo').value.trim(),
    notas         : document.getElementById('cita-notas').value.trim(),
  };
  if (!payload.mascota_id || !payload.veterinario_id || !payload.fecha_hora || !payload.motivo) {
    toast('Completa todos los campos obligatorios.', 'danger');
    return;
  }
  try {
    const res  = await api('/citas', { method: 'POST', body: payload });
    const data = await res.json();
    if (!res.ok) { toast(data.message || 'Error al guardar cita.', 'danger'); return; }
    toast('✅ Cita guardada correctamente', 'success');
    closeModal('modal-cita');
    cargarCitas();
  } catch (e) {
    toast('Error de conexión.', 'danger');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PROPIETARIOS
// ══════════════════════════════════════════════════════════════════════════════
async function cargarPropietarios() {
  const search = document.getElementById('search-prop')?.value || '';
  const tbody  = document.getElementById('propietarios-body');
  tbody.innerHTML = '<tr><td colspan="5" class="px-5 py-8 text-center text-gray-400">Cargando…</td></tr>';
  try {
    const res  = await api(`/propietarios?search=${encodeURIComponent(search)}`);
    const data = await res.json();
    if (!data.data.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="px-5 py-8 text-center text-gray-400">Sin resultados</td></tr>';
      return;
    }
    tbody.innerHTML = data.data.map((p) => `
      <tr class="hover:bg-gray-50 cursor-pointer">
        <td class="px-5 py-3 font-medium">${esc(p.nombre)} ${esc(p.apellido)}</td>
        <td class="px-5 py-3 text-gray-600 hidden sm:table-cell">${esc(p.dni || '—')}</td>
        <td class="px-5 py-3 text-gray-600">${esc(p.telefono)}</td>
        <td class="px-5 py-3 text-gray-600 hidden md:table-cell">${esc(p.email || '—')}</td>
        <td class="px-5 py-3">
          <span class="bg-primary-light text-primary text-xs font-semibold px-2 py-1 rounded-full">
            ${p.total_mascotas} 🐾
          </span>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="5" class="px-5 py-8 text-center text-red-400">Error al cargar</td></tr>';
  }
}

async function guardarPropietario() {
  const payload = {
    nombre   : document.getElementById('prop-nombre').value.trim(),
    apellido : document.getElementById('prop-apellido').value.trim(),
    dni      : document.getElementById('prop-dni').value.trim(),
    telefono : document.getElementById('prop-telefono').value.trim(),
    email    : document.getElementById('prop-email').value.trim(),
    direccion: document.getElementById('prop-direccion').value.trim(),
  };
  if (!payload.nombre || !payload.apellido || !payload.telefono) {
    toast('Nombre, apellido y teléfono son obligatorios.', 'danger');
    return;
  }
  try {
    const res  = await api('/propietarios', { method: 'POST', body: payload });
    const data = await res.json();
    if (!res.ok) { toast(data.message || 'Error.', 'danger'); return; }
    toast('✅ Propietario registrado', 'success');
    closeModal('modal-propietario');
    cargarPropietarios();
  } catch {
    toast('Error de conexión.', 'danger');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICACIONES
// ══════════════════════════════════════════════════════════════════════════════
function agregarNotifPanel({ tipo, titulo, mensaje }) {
  const list = document.getElementById('notif-list');
  if (list.querySelector('li')?.textContent?.includes('Sin notificaciones')) {
    list.innerHTML = '';
  }
  const iconos = { cita_nueva: '📅', stock_minimo: '⚠️', vacuna_recordatorio: '💉', sistema: 'ℹ️' };
  const li = document.createElement('li');
  li.className = 'px-4 py-3 hover:bg-gray-50';
  li.innerHTML = `
    <div class="flex gap-2 items-start">
      <span class="text-lg mt-0.5">${iconos[tipo] || 'ℹ️'}</span>
      <div>
        <p class="text-sm font-semibold text-gray-800">${esc(titulo)}</p>
        <p class="text-xs text-gray-500 mt-0.5">${esc(mensaje)}</p>
        <p class="text-xs text-gray-300 mt-1">Ahora mismo</p>
      </div>
    </div>
  `;
  list.prepend(li);
  State.notifCount++;
  document.getElementById('notif-badge').classList.remove('hidden');
}

function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    State.notifCount = 0;
    document.getElementById('notif-badge').classList.add('hidden');
  }
}

async function marcarTodasLeidas() {
  await api('/notificaciones/leer-todas', { method: 'PATCH' });
  document.getElementById('notif-list').innerHTML =
    '<li class="px-4 py-6 text-center text-sm text-gray-400">Sin notificaciones</li>';
  document.getElementById('notif-badge').classList.add('hidden');
}

function incrementarBadgeCitas() {
  const badge = document.getElementById('badge-citas');
  badge.classList.remove('hidden');
  badge.textContent = (parseInt(badge.textContent) || 0) + 1;
}

// ══════════════════════════════════════════════════════════════════════════════
// UTILIDADES UI
// ══════════════════════════════════════════════════════════════════════════════
function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

function toggleSidebar() {
  const sb      = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const open    = sb.classList.contains('-translate-x-full');
  sb.classList.toggle('-translate-x-full', !open);
  overlay.classList.toggle('hidden', !open);
}

function closeSidebar() {
  document.getElementById('sidebar').classList.add('-translate-x-full');
  document.getElementById('sidebar-overlay').classList.add('hidden');
}

function toast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${message}</span>`;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

const esc = (s) => String(s ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatFecha(iso) {
  return new Date(iso).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });
}

function hora(iso) {
  return new Date(iso).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
}

function badgeEstado(estado) {
  const map = {
    pendiente  : 'bg-yellow-100 text-yellow-700',
    confirmada : 'bg-blue-100 text-blue-700',
    en_curso   : 'bg-purple-100 text-purple-700',
    completada : 'bg-green-100 text-green-700',
    cancelada  : 'bg-red-100 text-red-600',
  };
  const cls = map[estado] || 'bg-gray-100 text-gray-600';
  return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${cls}">${estado}</span>`;
}

document.addEventListener('click', (e) => {
  const panel = document.getElementById('notif-panel');
  if (!panel.classList.contains('hidden') &&
      !panel.contains(e.target) &&
      !e.target.closest('[onclick="toggleNotifPanel()"]')) {
    panel.classList.add('hidden');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !document.getElementById('section-login').classList.contains('hidden')) {
    doLogin();
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════
function initApp() {
  const { user } = State;
  if (!user) return;
  document.getElementById('user-name').textContent    = user.nombre;
  document.getElementById('user-rol').textContent     = user.rol;
  document.getElementById('user-avatar').textContent  = user.nombre.charAt(0).toUpperCase();
  connectSocket();
  showOnly('dashboard');
  cargarDashboard();
  cargarVetsSelect();
}

async function cargarVetsSelect() {
  const select = document.getElementById('cita-vet-id');
  if (!select) return;
  select.innerHTML = '<option value="">Seleccionar veterinario…</option>';
}

if (State.accessToken && State.user) {
  initApp();
} else {
  showOnly('login');
}