/**
 * VetClinic — Layout shell v6
 * Permisos por PLAN (básico/profesional/premium)
 * Sin permisos granulares por botón
 */

// ── Módulos por plan ──────────────────────────────────────────────
const MODULOS_POR_PLAN = {
  basic: [
    'dashboard','citas','propietarios','mascotas','historia','servicios',
  ],
  pro: [
    'dashboard','citas','propietarios','mascotas','historia',
    'inventario','reportes','servicios',
  ],
  enterprise: [
    'dashboard','citas','propietarios','mascotas','historia',
    'inventario','facturacion','caja','reportes','servicios',
    'consentimientos','usuarios','configuracion',
  ],
};

// ── Todos los links del sistema ───────────────────────────────────
const TODOS_LOS_LINKS = [
  { id:'dashboard',      icon:'📊', label:'Dashboard',        href:'dashboard.html',      roles:['admin','veterinario','recepcionista'] },
  { id:'citas',          icon:'📅', label:'Citas',            href:'citas.html',          roles:['admin','veterinario','recepcionista'] },
  { id:'propietarios',   icon:'👥', label:'Propietarios',     href:'propietarios.html',   roles:['admin','veterinario','recepcionista'] },
  { id:'mascotas',       icon:'🐾', label:'Mascotas',         href:'mascotas.html',       roles:['admin','veterinario','recepcionista'] },
  { id:'historia',       icon:'📋', label:'Historia Clínica', href:'historia.html',       roles:['admin','veterinario','recepcionista'] },
  { id:'inventario',     icon:'📦', label:'Inventario',       href:'inventario.html',     roles:['admin','veterinario','recepcionista'] },
  { id:'facturacion',    icon:'🧾', label:'Facturación',      href:'facturacion.html',    roles:['admin','recepcionista'] },
  { id:'caja',           icon:'🏦', label:'Cierre de Caja',   href:'caja.html',           roles:['admin','recepcionista'] },
  { id:'servicios',      icon:'🛎️', label:'Servicios',        href:'servicios.html',      roles:['admin','recepcionista'] },
  { id:'reportes',       icon:'📈', label:'Reportes',         href:'reportes.html',       roles:['admin'] },
  { id:'consentimientos',icon:'📄', label:'Consentimientos',  href:'consentimientos.html',roles:['admin','veterinario'] },
  { id:'usuarios',       icon:'👤', label:'Usuarios',         href:'usuarios.html',       roles:['admin'] },
  { id:'configuracion',  icon:'⚙️', label:'Configuración',    href:'configuracion.html',  roles:['admin'] },
];

function renderShell({ activePage, title, subtitle }) {
  const user = JSON.parse(localStorage.getItem('vet_user') || '{}');
  const rol  = user.rol || 'recepcionista';

  // Filtrar por rol (sin branding aún — se aplica después)
  const nav     = TODOS_LOS_LINKS.filter(n => n.roles.includes(rol));
  const navHTML = nav.map(n => `
    <a href="${n.href}" class="sb-link ${n.id === activePage ? 'active' : ''}" data-modulo="${n.id}">
      <span class="icon">${n.icon}</span>
      <span>${n.label}</span>
    </a>`).join('');

  document.body.insertAdjacentHTML('afterbegin', `
    <aside id="sidebar" class="sidebar-closed">
      <div class="sb-logo">
        <div class="sb-logo-icon" id="sidebar-logo-icon">🐾</div>
        <img id="sidebar-logo-img" src="" alt="Logo"
          style="display:none;width:36px;height:36px;object-fit:contain;border-radius:.5rem"/>
        <div>
          <span class="sb-logo-text" id="sidebar-clinica-nombre">VetClinic</span>
          <span class="sb-logo-sub">Gestión Veterinaria</span>
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

  const applySidebar = () => {
    const sb = document.getElementById('sidebar');
    if (window.innerWidth >= 1024) sb.classList.remove('sidebar-closed');
    else sb.classList.add('sidebar-closed');
  };
  applySidebar();
  window.addEventListener('resize', applySidebar);

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

  // Módulos habilitados por el plan
  const modulosPlan = [...(MODULOS_POR_PLAN[plan] || MODULOS_POR_PLAN.basic)];

  // Módulos desactivados manualmente por el admin SaaS
  // Solo desactivar módulos que tienen toggle propio — no afectar módulos base
  if (!branding.modulo_facturacion) {
    ['facturacion','caja'].forEach(m => {
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

  // Ocultar links que NO están en el plan final
  sidebar.querySelectorAll('a[data-modulo]').forEach(el => {
    const modulo = el.getAttribute('data-modulo');
    if (!modulosPlan.includes(modulo)) {
      el.style.display = 'none';
    } else {
      el.style.display = ''; // asegurar que se muestra
    }
  });

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
          <div style="margin-top:1rem;padding:.65rem 1.1rem;background:#f0fdf4;border:1px solid #bbf7d0;
            border-radius:.85rem;font-size:.82rem;color:#15803d;display:inline-block">
            Plan actual: <strong>${plan.toUpperCase()}</strong>
          </div>
          <br/>
          <a href="dashboard.html" class="vbtn vbtn-primary" style="margin-top:1.25rem;display:inline-flex">
            ← Volver al Dashboard
          </a>
        </div>`;
    }
  }
}