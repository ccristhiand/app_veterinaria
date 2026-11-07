/**
 * VetClinic — Layout shell v7
 * Permisos por PLAN (básico/profesional/premium)
 * v7: + módulo Sedes (solo admin), + badge de sede en sidebar
 */

// ── Módulos por plan ──────────────────────────────────────────────
const MODULOS_POR_PLAN = {
  basic: [
    'dashboard','citas','calendario','propietarios','mascotas','historia','servicios',
    'asistencia','whatsapp',
  ],
  pro: [
    'dashboard','citas','calendario','propietarios','mascotas','historia',
    'inventario','reportes','servicios','asistencia','whatsapp',
  ],
  enterprise: [
    'dashboard','citas','calendario','propietarios','mascotas','historia',
    'inventario','facturacion','punto_venta','caja','gastos','reportes','servicios',
    'consentimientos','usuarios','configuracion','asistencia','whatsapp',
  ],
};

// ── Todos los links del sistema ───────────────────────────────────
// NUEVO: 'sedes' con roles:['admin'] — solo el admin de la clínica lo ve
const TODOS_LOS_LINKS = [
  { id:'dashboard',      icon:'📊', label:'Dashboard',        href:'dashboard',      roles:['admin','veterinario','recepcionista','veterinario_recepcionista'] },
  { id:'citas',          icon:'📅', label:'Citas',            href:'citas',          roles:['admin','veterinario','recepcionista','veterinario_recepcionista','groomer'] },
  { id:'calendario',     icon:'🗓️', label:'Calendario',       href:'calendario',     roles:['admin','veterinario','recepcionista','veterinario_recepcionista','groomer'] },
  { id:'propietarios',   icon:'👥', label:'Propietarios',     href:'propietarios',   roles:['admin','veterinario','recepcionista','veterinario_recepcionista','groomer'] },
  { id:'mascotas',       icon:'🐾', label:'Mascotas',         href:'mascotas',       roles:['admin','veterinario','recepcionista','veterinario_recepcionista','groomer'] },
  { id:'historia',       icon:'📋', label:'Historia Clínica', href:'historia',       roles:['admin','veterinario','recepcionista','veterinario_recepcionista','groomer'] },
  { id:'inventario',     icon:'📦', label:'Inventario',       href:'inventario',     roles:['admin','veterinario','recepcionista','veterinario_recepcionista'] },
  { id:'facturacion',    icon:'🧾', label:'Facturación',      href:'facturacion',    roles:['admin','recepcionista','veterinario_recepcionista'] },
  { id:'punto_venta',    icon:'🛒', label:'Punto de Venta',   href:'punto-venta',    roles:['admin','recepcionista','veterinario_recepcionista'] },
  { id:'caja',           icon:'🏦', label:'Cierre de Caja',   href:'caja',           roles:['admin','recepcionista','veterinario_recepcionista'] },
  { id:'gastos',         icon:'💸', label:'Gastos diarios',   href:'gastos',         roles:['admin','recepcionista','veterinario_recepcionista'] },
  { id:'servicios',      icon:'🛎️', label:'Servicios',        href:'servicios',      roles:['admin','recepcionista','veterinario_recepcionista'] },
  { id:'reportes',       icon:'📈', label:'Reportes',         href:'reportes',       roles:['admin'] },
  { id:'asistencia',     icon:'🕐', label:'Asistencia',        href:'asistencia',     roles:['admin','veterinario','recepcionista','veterinario_recepcionista','groomer'] },
  { id:'consentimientos',icon:'📄', label:'Consentimientos',  href:'consentimientos',roles:['admin','veterinario','veterinario_recepcionista'] },
  { id:'usuarios',       icon:'👤', label:'Usuarios',         href:'usuarios',       roles:['admin'] },
  { id:'sedes',          icon:'🏥', label:'Sedes',            href:'sedes',          roles:['admin'] },
  { id:'configuracion',  icon:'⚙️', label:'Configuración',    href:'configuracion',  roles:['admin'] },
  { id:'whatsapp',       icon:'💬', label:'WhatsApp',         href:'whatsapp',       roles:['admin'] },
  { id:'whatsapp_meta',  icon:'✅', label:'WhatsApp Meta',    href:'whatsapp-meta',  roles:['admin'] },
];

// ── Íconos SVG del menú (trazo, heredan el color del texto) ───────
// Reemplazan a los emojis, que se ven distintos en Android, iPhone y Windows.
const ICONOS = {
  dashboard      : '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  citas          : '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4"/>',
  calendario     : '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
  propietarios   : '<path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>',
  mascotas       : '<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 015 5v3.5a3.5 3.5 0 01-6.84 1.05Q6.52 17.48 4.46 16.84A3.5 3.5 0 015.5 10z"/>',
  historia       : '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01"/>',
  inventario     : '<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.3 7L12 12l8.7-5M12 22V12M7.5 4.2l9 5.2"/>',
  facturacion    : '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M16 8h-6a2 2 0 100 4h4a2 2 0 110 4H8M12 17.5v-11"/>',
  punto_venta    : '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2 2h2l2.7 12.4a2 2 0 002 1.6h9.7a2 2 0 002-1.6L22 7H5.1"/>',
  caja           : '<path d="M19 7V4a1 1 0 00-1-1H5a2 2 0 000 4h15a1 1 0 011 1v4h-3a2 2 0 000 4h3a1 1 0 001-1v-2a1 1 0 00-1-1"/><path d="M3 5v14a2 2 0 002 2h15a1 1 0 001-1v-4"/>',
  gastos         : '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4M16 15h2"/>',
  servicios      : '<path d="M5 2H4a2 2 0 00-2 2v5a6 6 0 0012 0V4a2 2 0 00-2-2h-1"/><path d="M8 15v1a6 6 0 0012 0v-4"/><circle cx="20" cy="10" r="2"/>',
  reportes       : '<path d="M3 3v18h18M18 17V9M13 17V5M8 17v-3"/>',
  asistencia     : '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  consentimientos: '<path d="M15 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7z"/><path d="M14 2v4a2 2 0 002 2h4M16 13H8M16 17H8M10 9H8"/>',
  usuarios       : '<path d="M19 21v-2a4 4 0 00-4-4H9a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  sedes          : '<path d="M6 22V4a2 2 0 012-2h8a2 2 0 012 2v18z"/><path d="M6 12H4a2 2 0 00-2 2v6a2 2 0 002 2h2M18 9h2a2 2 0 012 2v9a2 2 0 01-2 2h-2M12 6v4M10 8h4M10 14h4M10 18h4"/>',
  configuracion  : '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
  whatsapp       : '<path d="M7.9 20A9 9 0 104 16.1L2 22z"/>',
  whatsapp_meta  : '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/><path d="M9 10l2 2 4-4"/>',
  mas            : '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
};

function svgIcono(id, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONOS[id] || ICONOS.mas}</svg>`;
}

// ── Barra inferior (solo celular) ─────────────────────────────────
// 4 accesos según el rol + "Más", que abre el menú completo.
// Se toman en este orden y solo si el módulo está visible (rol + plan).
const BNAV_PREFERIDOS = {
  groomer                  : ['citas','calendario','mascotas','propietarios'],
  veterinario              : ['dashboard','citas','historia','mascotas','calendario','propietarios'],
  recepcionista            : ['dashboard','citas','propietarios','punto_venta','calendario','mascotas'],
  veterinario_recepcionista: ['dashboard','citas','historia','punto_venta','mascotas','calendario'],
  admin                    : ['dashboard','citas','mascotas','punto_venta','calendario','historia'],
};
const BNAV_CORTO = { dashboard:'Inicio', calendario:'Agenda', propietarios:'Clientes', historia:'Historia', punto_venta:'Ventas' };

let _paginaActiva = null;

function renderBottomNav() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const visibles = [...sidebar.querySelectorAll('a[data-modulo]')]
    .filter(a => a.style.display !== 'none')
    .map(a => a.getAttribute('data-modulo'));

  const user  = JSON.parse(localStorage.getItem('vet_user') || '{}');
  const orden = BNAV_PREFERIDOS[user.rol] || BNAV_PREFERIDOS.admin;
  const ids   = [...orden, ...visibles].filter((id, i, arr) => visibles.includes(id) && arr.indexOf(id) === i).slice(0, 4);
  const enMas = !ids.includes(_paginaActiva);

  const items = ids.map(id => {
    const link = TODOS_LOS_LINKS.find(n => n.id === id);
    const act  = id === _paginaActiva;
    return `<a href="${link.href}" class="bnav-item${act ? ' active' : ''}"${act ? ' aria-current="page"' : ''}>
      <span class="bnav-ico">${svgIcono(id, 22)}</span><span class="bnav-txt">${BNAV_CORTO[id] || link.label}</span></a>`;
  }).join('');

  let nav = document.getElementById('bottom-nav');
  if (!nav) {
    nav = document.createElement('nav');
    nav.id = 'bottom-nav';
    nav.className = 'bnav';
    nav.setAttribute('aria-label', 'Navegación principal');
    document.body.appendChild(nav);
  }
  nav.innerHTML = items + `
    <button type="button" class="bnav-item${enMas ? ' active' : ''}" onclick="toggleSidebar()" aria-label="Más módulos">
      <span class="bnav-ico">${svgIcono('mas', 22)}</span><span class="bnav-txt">Más</span></button>`;
}

// ── Tablas → fichas en celular ────────────────────────────────────
// Pone data-label (título de la columna) en cada celda de las tablas .vtable-stack
// para que app.css las muestre como fichas en celular. Observa el DOM porque las
// filas se cargan con innerHTML después de cada consulta a la API.
function etiquetarTablas() {
  document.querySelectorAll('table.vtable-stack').forEach(tabla => {
    const ths     = [...tabla.querySelectorAll('thead th')];
    const titulos = ths.map(th => th.textContent.trim());
    if (!titulos.length) return;
    // <th data-main> elige la columna que encabeza la ficha; si no, la primera con título
    const marcada   = ths.findIndex(th => th.hasAttribute('data-main'));
    const principal = marcada > -1 ? marcada : titulos.findIndex(t => t && t !== '#');
    tabla.querySelectorAll('tbody > tr:not([data-etiquetada])').forEach(tr => {
      [...tr.cells].forEach((td, i) => {
        if (td.colSpan > 1)                     td.classList.add('cell-full');
        else if (i === principal)               td.classList.add('cell-main');
        else if (!titulos[i] || /^acci/i.test(titulos[i])) td.classList.add('cell-actions');
        else                                    td.dataset.label = titulos[i];
      });
      tr.dataset.etiquetada = '1';
    });
  });
}

// ── Teclado en pantalla (celular/tablet) ──────────────────────────
// Marca html.teclado-abierto cuando el teclado virtual achica la pantalla visible,
// para ocultar las barras fijas que lo tapan. No se usa :focus porque hay páginas
// que enfocan un campo al cargar (p. ej. el buscador del Punto de Venta) sin abrir teclado.
if (window.visualViewport) {
  const revisarTeclado = () => document.documentElement.classList.toggle(
    'teclado-abierto', window.innerHeight - window.visualViewport.height > 150);
  window.visualViewport.addEventListener('resize', revisarTeclado);
}

let _etiquetarPendiente = false;
new MutationObserver(() => {
  if (_etiquetarPendiente) return;
  _etiquetarPendiente = true;
  requestAnimationFrame(() => { _etiquetarPendiente = false; etiquetarTablas(); });
}).observe(document.documentElement, { childList: true, subtree: true });

function renderShell({ activePage, title, subtitle }) {
  _paginaActiva = activePage;
  const user = JSON.parse(localStorage.getItem('vet_user') || '{}');
  const rol  = user.rol || 'recepcionista';

  // ── NUEVO: Badge de sede para mostrar en el área del usuario ──
  const sedeBadge = user.sede_nombre
    ? `<span style="display:inline-flex;align-items:center;gap:.25rem;margin-top:.25rem;
        font-size:.62rem;font-weight:700;color:var(--sidebar-active);background:var(--sidebar-hover);
        border:1px solid rgba(255,255,255,.15);border-radius:.5rem;
        padding:.15rem .5rem;letter-spacing:.02em;">
        🏥 ${esc(user.sede_nombre)}
      </span>`
    : '';

  const nav     = TODOS_LOS_LINKS.filter(n => n.roles.includes(rol));
  const navHTML = nav.map(n => `
    <a href="${n.href}" class="sb-link ${n.id === activePage ? 'active' : ''}" data-modulo="${n.id}" title="${n.label}"
       ${n.id === 'whatsapp_meta' ? 'style="display:none"' : ''}>
      <span class="icon">${svgIcono(n.id)}</span>
      <span class="sb-label">${n.label}</span>
    </a>`).join('');

  document.body.insertAdjacentHTML('afterbegin', `
    <aside id="sidebar" class="sidebar-closed">
      <div class="sb-logo">
        <div class="sb-logo-icon" id="sidebar-logo-icon">🐾</div>
        <img id="sidebar-logo-img" src="" alt="Logo"
          style="display:none;width:36px;height:36px;object-fit:contain;border-radius:.5rem"/>
        <div>
          <span class="sb-logo-text" id="sidebar-clinica-nombre">VetClinic</span>
          <span class="sb-logo-sub" id="sidebar-clinica-sub">Gestión Veterinaria</span>
        </div>
      </div>

      <nav class="sb-nav">
        <p class="sb-section">Menú principal</p>
        ${navHTML}
      </nav>

      <div class="sb-user">
        <div class="sb-avatar" id="user-avatar">?</div>
        <div style="flex:1;min-width:0">
          <p class="sb-user-name" id="user-name">Cargando…</p>
          <p class="sb-user-rol"  id="user-rol">—</p>
          <div id="user-sede-badge">${sedeBadge}</div>
          <a href="cambiar-password"
            style="font-size:.65rem;color:var(--sidebar-active);text-decoration:none;font-weight:600;
            display:inline-flex;align-items:center;gap:.25rem;margin-top:.1rem;opacity:.8"
            onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='.8'">
            🔐 Cambiar contraseña
          </a>
        </div>
        <button onclick="logout()" class="sb-logout" title="Cerrar sesión">
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h5a2 2 0 012 2v1"/>
          </svg>
        </button>
      </div>
    </aside>

    <div id="sidebar-overlay" class="hidden" onclick="toggleSidebar()"
      style="position:fixed;inset:0;background:rgba(13,59,46,.35);z-index:35;backdrop-filter:blur(2px)"></div>
  `);

  // Celular: menú oculto (se abre con "Más") · Tablet: barra angosta de íconos que el
  // hamburguesa despliega · Escritorio: menú completo fijo.
  // Solo se reajusta al cruzar los 1024px: en celular el evento resize también salta
  // al mostrarse/ocultarse la barra del navegador y cerraba el menú abierto.
  let escritorio = null;
  const applySidebar = () => {
    const ahora = window.innerWidth >= 1024;
    if (ahora === escritorio) return;
    escritorio = ahora;
    document.getElementById('sidebar').classList.toggle('sidebar-closed', !ahora);
    document.getElementById('sidebar-overlay')?.classList.add('hidden');
  };
  applySidebar();
  window.addEventListener('resize', applySidebar);
  renderBottomNav();

  const main = document.getElementById('main-content');
  if (main) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden';
    main.parentNode.insertBefore(wrapper, main);

    const header = document.createElement('header');
    header.className = 'topbar';
    header.innerHTML = `
      <button onclick="toggleSidebar()" class="hamburger">
        <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
        </svg>
      </button>
      <div style="flex:1">
        <h1 class="topbar-title" id="page-title">${title||''}</h1>
        ${subtitle ? `<p class="topbar-sub">${subtitle}</p>` : ''}
      </div>
      <button type="button" class="pwa-install-btn" data-pwa-install hidden onclick="pwaInstalar()"
        title="Instalar la app en este dispositivo">
        <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M5 17v2a2 2 0 002 2h10a2 2 0 002-2v-2"/>
        </svg>
        <span>Instalar app</span>
      </button>
      <div class="ws-pill">
        <span id="ws-dot" class="ws-dot-off"></span>
        <span id="ws-label" class="hidden sm:inline">Conectando…</span>
      </div>
      <div style="position:relative">
        <button onclick="toggleNotifPanel()" class="notif-btn">
          <svg width="19" height="19" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
          </svg>
          <span id="notif-badge" class="hidden">0</span>
        </button>
        <div id="notif-panel" class="hidden">
          <div class="notif-header">
            <h3>🔔 Notificaciones</h3>
            <button onclick="marcarTodasLeidas()" class="notif-clear">Limpiar todo</button>
          </div>
          <ul id="notif-list">
            <li data-placeholder class="notif-empty"><span>🔔</span>Sin notificaciones nuevas</li>
          </ul>
        </div>
      </div>`;

    wrapper.appendChild(header);
    wrapper.appendChild(main);
    window.pwaActualizarBotones?.();

    document.addEventListener('click', e => {
      const panel = document.getElementById('notif-panel');
      if (panel && !panel.classList.contains('hidden') &&
          !panel.contains(e.target) && !e.target.closest('.notif-btn')) {
        panel.classList.add('hidden');
      }
    });
  }
}

function toggleNotifPanel() {
  document.getElementById('notif-panel')?.classList.toggle('hidden');
}

// ── initPage ──────────────────────────────────────────────────────
function initPage({ activePage, title, subtitle }) {
  const user = requireAuth();
  if (!user) return null;

  renderShell({ activePage, title, subtitle });
  renderUserInfo(user);

  // Cargar branding → aplica colores + módulos del plan
  cargarBranding().then(branding => {
    if (branding) {
      aplicarBranding(branding);
      aplicarModulosPlan(branding, activePage);
    }
  });

  // Sockets
  const socket = getSocket();
  socket.on('cita:nueva', msg => {
    addNotif({ tipo:'cita_nueva', titulo:`Nueva cita: ${msg.payload?.mascota_nombre||''}`, mensaje:msg.payload?.motivo||'' });
    toast(`📅 Nueva cita: ${msg.payload?.mascota_nombre}`, 'info');
  });
  socket.on('notif:stock_minimo', msg => {
    addNotif({ tipo:'stock_minimo', titulo:`Stock bajo: ${msg.payload?.nombre}`, mensaje:`Quedan ${msg.payload?.cantidad} ${msg.payload?.unidad}` });
    toast(`⚠️ Stock bajo: ${msg.payload?.nombre}`, 'warning', 7000);
  });
  socket.on('notif:anulacion', msg => {
    addNotif({ tipo:'anulacion', titulo: msg.titulo||'🚫 Documento anulado', mensaje: msg.mensaje||'' });
    toast(`🚫 ${msg.numero} anulado`, 'warning', 6000);
  });

  return user;
}

// ── Aplicar módulos según plan + módulos habilitados ──────────────
function aplicarModulosPlan(branding, activePage) {
  const plan    = (branding.plan || 'basic').toLowerCase();
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  const user = JSON.parse(localStorage.getItem('vet_user') || '{}');

  // Módulos habilitados por el plan
  const modulosPlan = [...(MODULOS_POR_PLAN[plan] || MODULOS_POR_PLAN.basic)];

  // ── NUEVO: 'sedes' siempre visible para admin, sin importar plan ──
  if (user.rol === 'admin' && !modulosPlan.includes('sedes')) {
    modulosPlan.push('sedes');
  }

  // Módulos desactivados manualmente por el admin SaaS
  if (!branding.modulo_facturacion) {
    ['facturacion','punto_venta','caja','gastos'].forEach(m => {
      const idx = modulosPlan.indexOf(m);
      if (idx > -1) modulosPlan.splice(idx, 1);
    });
  }
  if (!branding.modulo_inventario) {
    const idx = modulosPlan.indexOf('inventario');
    if (idx > -1) modulosPlan.splice(idx, 1);
  }
  if (!branding.modulo_consentimientos) {
    const idx = modulosPlan.indexOf('consentimientos');
    if (idx > -1) modulosPlan.splice(idx, 1);
  }

  // ── WhatsApp: el admin SaaS decide qué pantallas ve la clínica ──
  // wa_ver_qr   → pantalla "WhatsApp" (conexión por QR)
  // wa_ver_meta → pantalla "WhatsApp Meta" (API oficial)
  const verQr   = branding.wa_ver_qr   === undefined ? true  : !!Number(branding.wa_ver_qr);
  const verMeta = branding.wa_ver_meta === undefined ? false : !!Number(branding.wa_ver_meta);
  if (!verQr) {
    const idx = modulosPlan.indexOf('whatsapp');
    if (idx > -1) modulosPlan.splice(idx, 1);
  }
  if (verMeta && !modulosPlan.includes('whatsapp_meta')) {
    modulosPlan.push('whatsapp_meta');
  }

  // Ocultar links que NO están en el plan final
  sidebar.querySelectorAll('a[data-modulo]').forEach(el => {
    const modulo = el.getAttribute('data-modulo');
    if (!modulosPlan.includes(modulo)) {
      el.style.display = 'none';
    } else {
      el.style.display = '';
    }
  });
  renderBottomNav();

  // ── NUEVO: actualizar subtítulo del sidebar con nombre de sede ──
  if (branding.nombre_clinica) {
    const subEl = document.getElementById('sidebar-clinica-sub');
    if (subEl) {
      const user2 = JSON.parse(localStorage.getItem('vet_user') || '{}');
      subEl.textContent = user2.sede_nombre
        ? `🏥 ${user2.sede_nombre}`
        : 'Gestión Veterinaria';
    }
  }

  // Groomer: páginas fuera de su rol muestran "sin acceso" (la API también las bloquea)
  const linkActual = TODOS_LOS_LINKS.find(n => n.id === activePage);
  if (user.rol === 'groomer' && linkActual && !linkActual.roles.includes('groomer')) {
    const main = document.getElementById('main-content');
    if (main) {
      main.innerHTML = `
        <div class="vempty" style="margin-top:5rem">
          <span style="font-size:3rem">🔒</span>
          <p style="font-size:1.1rem;font-weight:700;margin-top:.75rem">Sin acceso</p>
          <p style="font-size:.85rem;color:var(--ink-faint);margin-top:.3rem">Tu rol (Groomer) no tiene acceso a este módulo.</p>
          <a href="citas" class="vbtn vbtn-primary" style="margin-top:1.25rem;display:inline-flex">← Ir a Citas</a>
        </div>`;
    }
    return;
  }

  // Verificar acceso a la página actual
  if (activePage && !modulosPlan.includes(activePage)) {
    const main = document.getElementById('main-content');
    if (main) {
      main.innerHTML = `
        <div class="vempty" style="margin-top:5rem">
          <span style="font-size:3rem">🔒</span>
          <p style="font-size:1.1rem;font-weight:700;margin-top:.75rem">Módulo no disponible</p>
          <p style="font-size:.85rem;color:var(--ink-faint);margin-top:.3rem">
            Este módulo no está incluido en tu plan actual.<br/>
            Contacta al administrador para actualizar tu plan.
          </p>
          <div style="margin-top:1rem;padding:.65rem 1.1rem;background:var(--green-50);border:1px solid var(--green-200);
            border-radius:.85rem;font-size:.82rem;color:var(--green-700);display:inline-block">
            Plan actual: <strong>${plan.toUpperCase()}</strong>
          </div>
          <br/>
          <a href="dashboard" class="vbtn vbtn-primary" style="margin-top:1.25rem;display:inline-flex">
            ← Volver al Dashboard
          </a>
        </div>`;
    }
  }
}