/* ════════════════════════════════════════════════════════════════
   VetNetcodip — Módulo PROFORMAS (pestaña dentro de Facturación)
   Requiere (de facturacion.html / shared.js):
     api, esc, toast, openModal, closeModal, empresa, badgeEspecie,
     _cargarServicios, _buscarInventario, limpiarFormFac, selPropFac,
     addItem, addPagoFila, calcularTotales, html2canvas
   ════════════════════════════════════════════════════════════════ */

var _pfCfg        = null;   // { validez_dias, condiciones, serie, hoy }
var _pfEditId     = null;   // id en edición (null = nueva)
var _pfPropSel    = null;   // { id, nombre, apellido, dni, telefono }
var _pfItemN      = 0;
var _pfActual     = null;   // proforma abierta en "Ver"
var _pfFiltro     = 'abiertas';
var _pfPage       = 1;
var _pfConfirmFn  = null;
var _pfOrigenHist = null;   // historia_clinica_id cuando viene desde la historia
var _pfInit       = false;

var PF_ESTADOS = {
  borrador : { label:'📝 Borrador',  bg:'#f8fafc', color:'#475569', bd:'#e2e8f0' },
  enviada  : { label:'📤 Enviada',   bg:'#eff6ff', color:'#1d4ed8', bd:'#bfdbfe' },
  aceptada : { label:'👍 Aceptada',  bg:'#f0fdf4', color:'#15803d', bd:'#bbf7d0' },
  rechazada: { label:'👎 Rechazada', bg:'#fff1f2', color:'#be123c', bd:'#fecdd3' },
  vencida  : { label:'⌛ Vencida',   bg:'#fffbeb', color:'#b45309', bd:'#fde68a' },
  facturada: { label:'🧾 Facturada', bg:'#f5f3ff', color:'#6d28d9', bd:'#ddd6fe' },
};

// ── Utilidades ────────────────────────────────────────────────────
function pfMoney(n) { return 'S/. ' + (parseFloat(n) || 0).toFixed(2); }

function pfFecha(s) {                       // 'YYYY-MM-DD' → 'DD/MM/YYYY' sin desfase horario
  if (!s) return '—';
  var p = String(s).slice(0, 10).split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : s;
}

function pfDiasRestantes(validezHasta) {
  if (!validezHasta || !_pfCfg) return null;
  var a = new Date(_pfCfg.hoy + 'T00:00:00Z'), b = new Date(validezHasta + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

function pfBadge(estado) {
  var e = PF_ESTADOS[estado] || PF_ESTADOS.borrador;
  return '<span style="font-size:.68rem;font-weight:700;padding:.2rem .55rem;border-radius:999px;white-space:nowrap;' +
         'background:' + e.bg + ';color:' + e.color + ';border:1px solid ' + e.bd + '">' + e.label + '</span>';
}

function pfJson(res) { return res ? res.json().catch(function () { return {}; }) : Promise.resolve({}); }

async function pfCargarConfig(forzar) {
  if (_pfCfg && !forzar) return _pfCfg;
  try {
    var res = await api('/proformas/config');
    if (res && res.ok) _pfCfg = (await res.json()).data;
  } catch (e) {}
  if (!_pfCfg) _pfCfg = { validez_dias: 30, condiciones: '', serie: 'P001', hoy: fechaHoyInput() };
  return _pfCfg;
}

// ══════════════════════════════════════════════════════════════════
// 1. Estructura de la pestaña y modales (se inyectan una sola vez)
// ══════════════════════════════════════════════════════════════════
function pfMontarUI() {
  if (_pfInit) return;
  _pfInit = true;

  var cont = document.getElementById('contenido-proformas');
  if (cont) cont.innerHTML =
    '<div class="stats-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1rem;margin-bottom:1.2rem">' +
      pfStat('pf-st-abiertas', 'Abiertas', '#1d4ed8', 'pf-st-abiertas-sub') +
      pfStat('pf-st-cotizado', 'Cotizado este mes', 'var(--ink)', 'pf-st-cotizado-sub') +
      pfStat('pf-st-facturado', 'Facturado desde proformas', '#15803d', 'pf-st-facturado-sub') +
      pfStat('pf-st-tasa', 'Tasa de cierre', '#6d28d9', 'pf-st-tasa-sub') +
    '</div>' +

    '<div class="vcard vcard-pad filtros-wrap" style="margin-bottom:1rem">' +
      '<div style="flex:1;min-width:200px"><label class="vlabel">Buscar</label>' +
        '<input id="pf-q" type="text" class="vinput" placeholder="N° proforma, cliente, DNI o mascota…" ' +
        'onkeydown="if(event.key===\'Enter\'){_pfPage=1;cargarProformas();}"/></div>' +
      '<div><label class="vlabel">Desde</label><input id="pf-desde" type="date" class="vinput" style="width:auto"/></div>' +
      '<div><label class="vlabel">Hasta</label><input id="pf-hasta" type="date" class="vinput" style="width:auto"/></div>' +
      '<button onclick="_pfPage=1;cargarProformas()" class="vbtn vbtn-ghost">Filtrar</button>' +
      '<button onclick="abrirNuevaProforma()" class="vbtn vbtn-primary">＋ Nueva proforma</button>' +
    '</div>' +

    '<div class="subtabs-wrap" id="pf-subtabs">' +
      [['abiertas','📂 Abiertas'],['','📋 Todas'],['aceptada','👍 Aceptadas'],['facturada','🧾 Facturadas'],
       ['vencida','⌛ Vencidas'],['rechazada','👎 Rechazadas']].map(function (t) {
        return '<button class="tab-btn' + (t[0] === _pfFiltro ? ' active' : '') + '" data-pf="' + t[0] + '" ' +
               'onclick="pfSetFiltro(\'' + t[0] + '\')">' + t[1] + '</button>';
      }).join('') +
    '</div>' +

    '<div class="vcard" style="overflow:hidden">' +
      '<div style="overflow-x:auto"><table class="vtable"><thead><tr>' +
        '<th>Número</th><th>Fecha</th><th>Cliente</th>' +
        '<th class="hidden sm:table-cell">Mascota</th>' +
        '<th class="hidden md:table-cell">Vence</th>' +
        '<th>Total</th><th>Estado</th><th>Acciones</th>' +
      '</tr></thead><tbody id="pf-tbody"></tbody></table></div>' +
    '</div>' +
    '<div id="pf-paginacion" style="display:flex;justify-content:center;gap:.5rem;margin-top:1rem"></div>';

  document.body.insertAdjacentHTML('beforeend', pfModalesHTML());
}

function pfStat(id, titulo, color, subId) {
  return '<div class="vcard vcard-pad">' +
    '<p style="font-size:.68rem;color:var(--ink-faint);text-transform:uppercase;letter-spacing:.1em;font-weight:700">' + titulo + '</p>' +
    '<p style="font-size:1.45rem;font-weight:800;color:' + color + ';margin-top:.3rem" id="' + id + '">—</p>' +
    '<p style="font-size:.7rem;color:var(--ink-faint);margin-top:.15rem" id="' + subId + '"></p></div>';
}

function pfModalesHTML() {
  return '' +
  // ── Modal crear / editar ─────────────────────────────────────
  '<div id="modal-proforma" class="hidden vmodal-backdrop">' +
   '<div class="vmodal" style="max-width:760px">' +
    '<div class="vmodal-head"><h3 id="pf-form-titulo">📝 Nueva proforma</h3>' +
      '<button onclick="closeModal(\'modal-proforma\')" class="vmodal-close">✕</button></div>' +
    '<div class="vmodal-body" style="display:flex;flex-direction:column;gap:1.1rem">' +

      '<div id="pf-aviso-vencida" style="display:none;background:#fffbeb;border:1px solid #fde68a;border-radius:.85rem;padding:.7rem 1rem;font-size:.78rem;color:#b45309">' +
        '⌛ Esta proforma estaba vencida. Al guardar se renueva la validez desde la fecha indicada.</div>' +

      '<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">' +
        '<div><label class="vlabel">Fecha *</label><input id="pf-fecha" type="date" class="vinput" onchange="pfActualizarVence()"/></div>' +
        '<div><label class="vlabel">Validez (días) *</label>' +
          '<input id="pf-validez" type="number" min="1" max="365" step="1" class="vinput" oninput="pfActualizarVence()"/></div>' +
        '<div><label class="vlabel">Válida hasta</label>' +
          '<div id="pf-vence" class="vinput" style="background:#f8faf8;font-weight:700;color:#15803d">—</div></div>' +
      '</div>' +

      // Propietario
      '<div style="background:#f8faf8;border:1px solid var(--line);border-radius:1rem;padding:1rem">' +
        '<p style="font-size:.72rem;font-weight:700;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.1em;margin-bottom:.7rem">👤 Propietario / Cliente</p>' +
        '<div id="pf-prop-buscar" style="display:flex;gap:.6rem">' +
          '<input id="pf-prop-q" type="text" class="vinput" style="flex:1" placeholder="DNI, nombre o teléfono…" ' +
            'onkeydown="if(event.key===\'Enter\')pfBuscarProp()"/>' +
          '<button onclick="pfBuscarProp()" class="vbtn vbtn-primary">Buscar</button>' +
        '</div>' +
        '<div id="pf-prop-res" style="display:flex;flex-direction:column;gap:.4rem;max-height:150px;overflow-y:auto;margin-top:.5rem"></div>' +
        '<div id="pf-prop-sel" style="display:none;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:.8rem;padding:.65rem .9rem;align-items:center;gap:.75rem">' +
          '<div style="flex:1"><p style="font-weight:700;font-size:.88rem" id="pf-prop-nombre">—</p>' +
            '<p style="font-size:.7rem;color:var(--ink-soft)" id="pf-prop-info">—</p></div>' +
          '<button onclick="pfLimpiarProp()" style="background:none;border:none;cursor:pointer;color:var(--ink-faint)">✕</button>' +
        '</div>' +
        '<div id="pf-masc-wrap" style="display:none;margin-top:.7rem"><label class="vlabel">Mascota</label>' +
          '<select id="pf-mascota" class="vinput"><option value="">Sin mascota específica</option></select></div>' +
      '</div>' +

      // IGV
      '<label style="display:flex;align-items:center;gap:.6rem;cursor:pointer;font-size:.84rem;font-weight:600;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:.9rem;padding:.7rem 1rem">' +
        '<input type="checkbox" id="pf-igv" checked onchange="pfCalcular()" style="accent-color:var(--green-600);width:16px;height:16px"/>' +
        'Los precios incluyen IGV (<span id="pf-igv-pct">18</span>%)</label>' +

      // Ítems
      '<div style="border-top:1px solid var(--line);padding-top:1rem">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">' +
          '<label style="font-weight:700;font-size:.88rem;font-family:\'Playfair Display\',serif">📝 Servicios y productos</label>' +
          '<button onclick="pfAddItem()" class="vbtn vbtn-primary" style="font-size:.78rem;padding:.4rem .9rem">＋ Agregar ítem</button>' +
        '</div>' +
        '<div class="item-header-grid">' +
          '<p style="font-size:.63rem;font-weight:700;color:var(--ink-faint);text-transform:uppercase">Descripción</p>' +
          '<p style="font-size:.63rem;font-weight:700;color:var(--ink-faint);text-transform:uppercase;text-align:center">Cant.</p>' +
          '<p style="font-size:.63rem;font-weight:700;color:var(--ink-faint);text-transform:uppercase;text-align:right">P. Unit.</p>' +
          '<p style="font-size:.63rem;font-weight:700;color:#be123c;text-transform:uppercase;text-align:center">Desc. %</p><p></p>' +
        '</div>' +
        '<div id="pf-items" style="display:flex;flex-direction:column;gap:.5rem"></div>' +
      '</div>' +

      // Descuento global
      '<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:.9rem;padding:.7rem 1rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap">' +
        '<label style="font-size:.83rem;font-weight:700;color:#c2410c">🏷️ Descuento global</label>' +
        '<div style="display:flex;align-items:center;gap:.5rem"><input type="number" id="pf-desc-global" min="0" max="100" step="0.5" value="0" ' +
          'class="vinput" style="width:80px;text-align:center" oninput="pfCalcular()"/><span style="font-weight:700;color:#c2410c">%</span></div>' +
      '</div>' +

      // Totales
      '<div style="background:#f0fdf4;border:1px solid #a7f3d0;border-radius:.9rem;padding:.85rem 1.1rem;display:flex;flex-direction:column;gap:.25rem;align-items:flex-end;font-size:.8rem">' +
        '<div style="display:flex;gap:3rem"><span style="color:var(--ink-faint)">Subtotal bruto:</span><span id="pf-t-bruto" style="min-width:90px;text-align:right;font-weight:600">S/. 0.00</span></div>' +
        '<div id="pf-row-desc" style="display:none;gap:3rem;color:#be123c"><span>− Descuentos:</span><span id="pf-t-desc" style="min-width:90px;text-align:right;font-weight:600">S/. 0.00</span></div>' +
        '<div style="display:flex;gap:3rem"><span style="color:var(--ink-soft)">Base imponible:</span><span id="pf-t-sub" style="min-width:90px;text-align:right;font-weight:600">S/. 0.00</span></div>' +
        '<div style="display:flex;gap:3rem"><span style="color:var(--ink-soft)" id="pf-t-igv-lbl">IGV (18%):</span><span id="pf-t-igv" style="min-width:90px;text-align:right;font-weight:600">S/. 0.00</span></div>' +
        '<div style="display:flex;gap:3rem;font-size:.98rem;font-weight:800;color:#15803d;border-top:2px solid #a7f3d0;padding-top:.3rem"><span>TOTAL:</span><span id="pf-t-total" style="min-width:90px;text-align:right">S/. 0.00</span></div>' +
      '</div>' +

      '<div><label class="vlabel">Notas para el cliente (opcional)</label>' +
        '<textarea id="pf-notas" rows="2" class="vinput" placeholder="Ej: Incluye exámenes prequirúrgicos. Ayuno de 8 horas."></textarea></div>' +
      '<div><label class="vlabel">Condiciones (se imprimen al pie)</label>' +
        '<textarea id="pf-condiciones" rows="3" class="vinput" style="font-size:.78rem"></textarea></div>' +
    '</div>' +
    '<div class="vmodal-foot">' +
      '<button onclick="closeModal(\'modal-proforma\')" class="vbtn vbtn-ghost">Cancelar</button>' +
      '<button id="pf-btn-guardar" onclick="guardarProforma()" class="vbtn vbtn-primary">💾 Guardar proforma</button>' +
    '</div>' +
   '</div>' +
  '</div>' +

  // ── Modal ver ────────────────────────────────────────────────
  '<div id="modal-ver-proforma" class="hidden vmodal-backdrop">' +
   '<div class="vmodal" style="max-width:680px">' +
    '<div class="vmodal-head"><h3 id="pf-ver-titulo">📝 Proforma</h3>' +
      '<button onclick="closeModal(\'modal-ver-proforma\')" class="vmodal-close">✕</button></div>' +
    '<div class="vmodal-body">' +
      '<div id="pf-ver-estado" style="margin-bottom:.9rem"></div>' +
      '<div id="pf-ver-acciones" style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem"></div>' +
      '<div id="pf-preview" style="border:1px solid var(--line);border-radius:.9rem;padding:1.4rem;background:#fff"></div>' +
    '</div>' +
    '<div class="vmodal-foot">' +
      '<button onclick="closeModal(\'modal-ver-proforma\')" class="vbtn vbtn-ghost">Cerrar</button>' +
      '<button onclick="pfEnviarWhatsApp()" class="vbtn" id="pf-btn-wa" style="background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;border:none">💬 WhatsApp</button>' +
      '<button onclick="pfImprimir()" class="vbtn vbtn-primary">🖨️ Imprimir / PDF</button>' +
    '</div>' +
   '</div>' +
  '</div>' +

  // ── Modal rechazo ────────────────────────────────────────────
  '<div id="modal-pf-rechazo" class="hidden vmodal-backdrop">' +
   '<div class="vmodal" style="max-width:440px">' +
    '<div class="vmodal-head"><h3>👎 Marcar como rechazada</h3>' +
      '<button onclick="closeModal(\'modal-pf-rechazo\')" class="vmodal-close">✕</button></div>' +
    '<div class="vmodal-body" style="display:flex;flex-direction:column;gap:.8rem">' +
      '<p style="font-size:.82rem;color:var(--ink-soft)">¿Por qué el cliente no aceptó? Esto ayuda a entender qué servicios cuesta más cerrar.</p>' +
      '<div style="display:flex;gap:.4rem;flex-wrap:wrap">' +
        ['Precio alto', 'Lo hará en otra clínica', 'Decidió no hacer el procedimiento', 'No respondió'].map(function (m) {
          return '<button type="button" class="vbtn vbtn-ghost" style="font-size:.72rem;padding:.3rem .65rem" ' +
                 'onclick="document.getElementById(\'pf-motivo\').value=\'' + m + '\'">' + m + '</button>';
        }).join('') +
      '</div>' +
      '<textarea id="pf-motivo" rows="3" class="vinput" placeholder="Motivo del rechazo…"></textarea>' +
    '</div>' +
    '<div class="vmodal-foot">' +
      '<button onclick="closeModal(\'modal-pf-rechazo\')" class="vbtn vbtn-ghost">Cancelar</button>' +
      '<button onclick="pfConfirmarRechazo()" class="vbtn" style="background:#be123c;color:#fff;border:none">👎 Confirmar</button>' +
    '</div>' +
   '</div>' +
  '</div>' +

  // ── Modal confirmación genérica ──────────────────────────────
  '<div id="modal-pf-confirm" class="hidden vmodal-backdrop">' +
   '<div class="vmodal" style="max-width:420px">' +
    '<div class="vmodal-head"><h3 id="pf-confirm-titulo">Confirmar</h3>' +
      '<button onclick="closeModal(\'modal-pf-confirm\')" class="vmodal-close">✕</button></div>' +
    '<div class="vmodal-body"><p id="pf-confirm-msg" style="font-size:.85rem;color:var(--ink-soft)"></p></div>' +
    '<div class="vmodal-foot">' +
      '<button onclick="closeModal(\'modal-pf-confirm\')" class="vbtn vbtn-ghost">Cancelar</button>' +
      '<button id="pf-confirm-btn" onclick="pfEjecutarConfirm()" class="vbtn vbtn-primary">Confirmar</button>' +
    '</div>' +
   '</div>' +
  '</div>';
}

function pfConfirmar(titulo, mensaje, textoBoton, peligro, fn) {
  document.getElementById('pf-confirm-titulo').textContent = titulo;
  document.getElementById('pf-confirm-msg').textContent    = mensaje;
  var btn = document.getElementById('pf-confirm-btn');
  btn.textContent = textoBoton;
  btn.style.cssText = peligro ? 'background:#be123c;color:#fff;border:none' : '';
  btn.className = peligro ? 'vbtn' : 'vbtn vbtn-primary';
  _pfConfirmFn = fn;
  openModal('modal-pf-confirm');
}

async function pfEjecutarConfirm() {
  var fn = _pfConfirmFn; _pfConfirmFn = null;
  closeModal('modal-pf-confirm');
  if (fn) await fn();
}

// ══════════════════════════════════════════════════════════════════
// 2. Pestaña: resumen + listado
// ══════════════════════════════════════════════════════════════════
async function abrirTabProformas() {
  pfMontarUI();
  await pfCargarConfig();
  cargarResumenProformas();
  cargarProformas();
}

function pfSetFiltro(f) {
  _pfFiltro = f; _pfPage = 1;
  document.querySelectorAll('#pf-subtabs .tab-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-pf') === f);
  });
  cargarProformas();
}

function pfRefrescar() {
  if (!_pfInit) return;
  cargarResumenProformas();
  cargarProformas();
}

async function cargarResumenProformas() {
  try {
    var res = await api('/proformas/resumen');
    if (!res || !res.ok) return;
    var d = (await res.json()).data;
    document.getElementById('pf-st-abiertas').textContent      = d.abiertas;
    document.getElementById('pf-st-abiertas-sub').textContent  = pfMoney(d.monto_abierto) + ' por cerrar';
    document.getElementById('pf-st-cotizado').textContent      = pfMoney(d.monto_cotizado);
    document.getElementById('pf-st-cotizado-sub').textContent  = d.total + ' proforma(s) este mes';
    document.getElementById('pf-st-facturado').textContent     = pfMoney(d.monto_facturado);
    document.getElementById('pf-st-facturado-sub').textContent = d.facturadas + ' convertida(s) en comprobante';
    document.getElementById('pf-st-tasa').textContent          = d.tasa_cierre + '%';
    document.getElementById('pf-st-tasa-sub').textContent      = d.rechazadas + ' rechazada(s) · ' + d.vencidas + ' vencida(s)';
  } catch (e) {}
}

async function cargarProformas() {
  var tbody = document.getElementById('pf-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8"><div class="vempty"><div class="vspinner"></div></div></td></tr>';

  var q     = document.getElementById('pf-q').value.trim();
  var desde = document.getElementById('pf-desde').value;
  var hasta = document.getElementById('pf-hasta').value;
  var url = '/proformas?page=' + _pfPage + '&limit=30' +
    (_pfFiltro ? '&estado=' + encodeURIComponent(_pfFiltro) : '') +
    (q ? '&search=' + encodeURIComponent(q) : '') +
    (desde ? '&desde=' + desde : '') + (hasta ? '&hasta=' + hasta : '');

  try {
    var res = await api(url);
    if (!res || !res.ok) { tbody.innerHTML = '<tr><td colspan="8"><div class="vempty">Error al cargar</div></td></tr>'; return; }
    var json = await res.json();
    var rows = json.data || [];
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="vempty"><span class="icon">📝</span><p>Sin proformas en esta vista</p></div></td></tr>';
      document.getElementById('pf-paginacion').innerHTML = '';
      return;
    }
    tbody.innerHTML = rows.map(function (p) {
      var dias = pfDiasRestantes(p.validez_hasta);
      var vence = pfFecha(p.validez_hasta);
      if (['borrador', 'enviada', 'aceptada'].indexOf(p.estado) >= 0 && dias !== null) {
        vence += dias <= 3
          ? ' <span style="font-size:.62rem;color:#b45309;font-weight:700">(' + (dias <= 0 ? 'hoy' : dias + 'd') + ')</span>'
          : '';
      }
      return '<tr>' +
        '<td><span style="font-family:monospace;font-size:.78rem;font-weight:700">' + esc(p.numero) + '</span></td>' +
        '<td style="font-size:.78rem">' + pfFecha(p.fecha) + '</td>' +
        '<td style="font-size:.8rem;font-weight:600">' + esc(p.propietario_nombre) + '</td>' +
        '<td class="hidden sm:table-cell" style="font-size:.75rem;color:var(--ink-soft)">' + esc(p.mascota_nombre || '—') + '</td>' +
        '<td class="hidden md:table-cell" style="font-size:.75rem">' + vence + '</td>' +
        '<td style="font-weight:700;white-space:nowrap">' + pfMoney(p.total) + '</td>' +
        '<td>' + pfBadge(p.estado) +
          (p.factura_numero ? '<div style="font-size:.62rem;color:#6d28d9;margin-top:.15rem;font-family:monospace">' + esc(p.factura_numero) + '</div>' : '') +
        '</td>' +
        '<td style="white-space:nowrap">' +
          '<button class="vlink" onclick="verProforma(' + p.id + ')" style="font-size:.72rem">👁️ Ver</button> ' +
          (['borrador', 'enviada', 'aceptada', 'vencida'].indexOf(p.estado) >= 0
            ? '<button class="vlink" onclick="convertirProforma(' + p.id + ')" style="font-size:.72rem;color:#15803d">🧾 Facturar</button>' : '') +
        '</td></tr>';
    }).join('');

    var pag = document.getElementById('pf-paginacion');
    var m = json.meta || {};
    pag.innerHTML = m.pages > 1
      ? '<button class="vbtn vbtn-ghost" ' + (_pfPage <= 1 ? 'disabled' : '') + ' onclick="_pfPage--;cargarProformas()">‹ Anterior</button>' +
        '<span style="font-size:.78rem;align-self:center;color:var(--ink-soft)">Página ' + m.page + ' de ' + m.pages + '</span>' +
        '<button class="vbtn vbtn-ghost" ' + (_pfPage >= m.pages ? 'disabled' : '') + ' onclick="_pfPage++;cargarProformas()">Siguiente ›</button>'
      : '';
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="vempty">Error de conexión</div></td></tr>';
  }
}

// ══════════════════════════════════════════════════════════════════
// 3. Formulario crear / editar
// ══════════════════════════════════════════════════════════════════
function pfLimpiarForm() {
  _pfEditId = null; _pfPropSel = null; _pfItemN = 0; _pfOrigenHist = null;
  document.getElementById('pf-form-titulo').textContent = '📝 Nueva proforma';
  document.getElementById('pf-aviso-vencida').style.display = 'none';
  document.getElementById('pf-fecha').value       = _pfCfg.hoy || fechaHoyInput();
  document.getElementById('pf-validez').value     = _pfCfg.validez_dias || 30;
  document.getElementById('pf-igv').checked       = true;
  document.getElementById('pf-igv-pct').textContent = parseFloat((typeof empresa !== 'undefined' && empresa.igv_porcentaje) || 18);
  document.getElementById('pf-desc-global').value = '0';
  document.getElementById('pf-notas').value       = '';
  document.getElementById('pf-condiciones').value = _pfCfg.condiciones || '';
  document.getElementById('pf-items').innerHTML   = '';
  pfLimpiarProp();
  pfActualizarVence();
  pfCalcular();
}

async function abrirNuevaProforma(opts) {
  pfMontarUI();
  await pfCargarConfig(true);
  pfLimpiarForm();
  openModal('modal-proforma');
  if (opts && opts.propietario_id) {
    await pfSeleccionarPropPorId(opts.propietario_id, opts.mascota_id);
    _pfOrigenHist = opts.historia_clinica_id || null;
    if (opts.notas) document.getElementById('pf-notas').value = opts.notas;
  }
  pfAddItem();
}

async function editarProforma(id) {
  closeModal('modal-ver-proforma');
  await pfCargarConfig(true);
  var res = await api('/proformas/' + id);
  var d = await pfJson(res);
  if (!res || !res.ok) { toast(d.message || 'No se pudo cargar.', 'danger'); return; }
  var pf = d.data;

  pfLimpiarForm();
  _pfEditId = pf.id;
  document.getElementById('pf-form-titulo').textContent = '✏️ Editar ' + pf.numero;
  document.getElementById('pf-aviso-vencida').style.display = pf.estado === 'vencida' ? 'block' : 'none';
  document.getElementById('pf-fecha').value       = pf.estado === 'vencida' ? _pfCfg.hoy : pf.fecha;
  document.getElementById('pf-validez').value     = pf.validez_dias;
  document.getElementById('pf-igv').checked       = !!pf.igv_incluido;
  document.getElementById('pf-desc-global').value = parseFloat(pf.descuento_global_pct) || 0;
  document.getElementById('pf-notas').value       = pf.notas || '';
  document.getElementById('pf-condiciones').value = pf.condiciones || '';
  openModal('modal-proforma');

  await pfSeleccionarPropPorId(pf.propietario_id, pf.mascota_id);
  (pf.items || []).forEach(function (it) { pfAddItem(it); });
  pfActualizarVence();
  pfCalcular();
}

function pfActualizarVence() {
  var f = document.getElementById('pf-fecha').value;
  var v = parseInt(document.getElementById('pf-validez').value);
  var el = document.getElementById('pf-vence');
  if (!f || !v || v < 1) { el.textContent = '—'; return; }
  var d = new Date(f + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + v);
  el.textContent = pfFecha(d.toISOString().slice(0, 10));
}

// ── Propietario ───────────────────────────────────────────────────
async function pfBuscarProp() {
  var q = document.getElementById('pf-prop-q').value.trim();
  var cont = document.getElementById('pf-prop-res');
  if (!q) { toast('Ingresa DNI, nombre o teléfono', 'warning'); return; }
  cont.innerHTML = '<div style="font-size:.78rem;color:var(--ink-faint)">Buscando…</div>';
  try {
    var res = await api('/propietarios?search=' + encodeURIComponent(q) + '&limit=6');
    var rows = res && res.ok ? ((await res.json()).data || []) : [];
    window._pfPropResultados = rows;
    cont.innerHTML = rows.length ? rows.map(function (p, i) {
      return '<button onclick="pfSelPropIdx(' + i + ')" style="display:flex;flex-direction:column;align-items:flex-start;padding:.55rem .85rem;background:#fff;' +
        'border:1px solid var(--line);border-radius:.8rem;cursor:pointer;text-align:left;font-family:inherit;width:100%">' +
        '<span style="font-weight:700;font-size:.83rem">' + esc(p.nombre) + ' ' + esc(p.apellido) + '</span>' +
        '<span style="font-size:.68rem;color:var(--ink-faint)">' + (p.dni ? '🪪 ' + esc(p.dni) + ' · ' : '') + '📞 ' + esc(p.telefono || '') + '</span></button>';
    }).join('') : '<div style="font-size:.78rem;color:var(--ink-faint);text-align:center">Sin resultados</div>';
  } catch (e) { cont.innerHTML = '<div style="font-size:.78rem;color:#e11d48">Error al buscar</div>'; }
}

function pfSelPropIdx(i) {
  var p = (window._pfPropResultados || [])[i];
  if (p) pfSeleccionarPropPorId(p.id, null);
}

async function pfSeleccionarPropPorId(propId, mascotaId) {
  try {
    var res = await api('/propietarios/' + propId);
    if (!res || !res.ok) { toast('No se pudo cargar el propietario.', 'danger'); return; }
    var p = (await res.json()).data;
    _pfPropSel = { id: p.id, nombre: p.nombre, apellido: p.apellido, dni: p.dni || '', telefono: p.telefono || '' };
    document.getElementById('pf-prop-res').innerHTML = '';
    document.getElementById('pf-prop-q').value = '';
    document.getElementById('pf-prop-buscar').style.display = 'none';
    document.getElementById('pf-prop-sel').style.display = 'flex';
    document.getElementById('pf-prop-nombre').textContent = p.nombre + ' ' + p.apellido;
    document.getElementById('pf-prop-info').textContent =
      (p.dni ? '🪪 ' + p.dni + ' · ' : '') + '📞 ' + (p.telefono || 'sin teléfono');

    var masc = p.mascotas || [];
    var sel = document.getElementById('pf-mascota');
    sel.innerHTML = '<option value="">Sin mascota específica</option>' + masc.map(function (m) {
      var ico = typeof badgeEspecie === 'function' ? badgeEspecie(m.especie) + ' ' : '';
      return '<option value="' + m.id + '">' + ico + esc(m.nombre) + '</option>';
    }).join('');
    if (mascotaId) sel.value = String(mascotaId);
    else if (masc.length === 1) sel.value = String(masc[0].id);
    document.getElementById('pf-masc-wrap').style.display = masc.length ? 'block' : 'none';
  } catch (e) { toast('Error al cargar el propietario.', 'danger'); }
}

function pfLimpiarProp() {
  _pfPropSel = null;
  document.getElementById('pf-prop-sel').style.display = 'none';
  document.getElementById('pf-prop-buscar').style.display = 'flex';
  document.getElementById('pf-masc-wrap').style.display = 'none';
  document.getElementById('pf-mascota').innerHTML = '<option value="">Sin mascota específica</option>';
  document.getElementById('pf-prop-res').innerHTML = '';
}

// ── Ítems ─────────────────────────────────────────────────────────
function pfAddItem(it) {
  it = it || {};
  var id = _pfItemN++;
  var div = document.createElement('div');
  div.id = 'pf-item-' + id;
  div.className = 'item-row';
  div.innerHTML =
    '<div class="item-desc-col" style="position:relative">' +
      '<input type="text" class="vinput" data-f="desc" placeholder="Busca servicio/producto o escribe…" style="font-size:.8rem;width:100%" ' +
        'value="' + esc(it.descripcion || '') + '" oninput="pfOnDescInput(this,' + id + ')"/>' +
      '<ul id="pf-ac-' + id + '" class="ac-factura-list" style="display:none"></ul>' +
    '</div>' +
    '<div class="item-nums-col">' +
      '<input type="number" class="vinput item-num-input" data-f="cant" min="0.5" step="0.5" style="font-size:.8rem;text-align:center" ' +
        'value="' + (parseFloat(it.cantidad) || 1) + '" oninput="pfCalcular()"/>' +
      '<input type="number" class="vinput item-num-input" data-f="pu" min="0" step="0.5" placeholder="Precio" style="font-size:.8rem;text-align:right" ' +
        'value="' + (it.precio_unit !== undefined ? parseFloat(it.precio_unit) : '') + '" oninput="pfCalcular()"/>' +
      '<div style="display:flex;align-items:center;gap:.2rem">' +
        '<input type="number" class="vinput item-num-input" data-f="dpct" min="0" max="100" step="0.5" ' +
          'style="font-size:.78rem;text-align:center;border-color:#fecdd3;max-width:58px" value="' + (parseFloat(it.descuento_pct) || 0) + '" oninput="pfCalcular()"/>' +
        '<span style="font-size:.72rem;color:#be123c;font-weight:700">%</span>' +
      '</div>' +
      '<input type="hidden" data-f="svc-id" value="' + (it.servicio_id || '') + '"/>' +
      '<input type="hidden" data-f="inv-id" value="' + (it.inventario_id || '') + '"/>' +
    '</div>' +
    '<div class="item-del-col"><button onclick="document.getElementById(\'pf-item-' + id + '\').remove();pfCalcular()" ' +
      'style="background:none;border:none;cursor:pointer;color:#e11d48;font-size:1.1rem">✕</button></div>';
  document.getElementById('pf-items').appendChild(div);
  pfCalcular();
}

var _pfAcTimers = {};
function pfOnDescInput(input, id) {
  // Si el usuario reescribe, deja de estar enlazado a un servicio/producto del catálogo
  var row = document.getElementById('pf-item-' + id);
  row.querySelector('[data-f="svc-id"]').value = '';
  row.querySelector('[data-f="inv-id"]').value = '';
  pfCalcular();

  clearTimeout(_pfAcTimers[id]);
  _pfAcTimers[id] = setTimeout(async function () {
    var q = input.value.trim();
    var ul = document.getElementById('pf-ac-' + id);
    if (!ul) return;
    if (q.length < 2) { ul.style.display = 'none'; return; }
    ul.innerHTML = '<li style="color:var(--ink-faint);font-size:.78rem;padding:.5rem">Buscando…</li>';
    ul.style.display = 'block';

    var qL = q.toLowerCase();
    var svcs = (await _cargarServicios()).filter(function (s) { return s.nombre.toLowerCase().indexOf(qL) >= 0; }).slice(0, 6);
    if (input.value.trim() !== q) return;
    var invs = await _buscarInventario(q);
    if (input.value.trim() !== q) return;

    var lista = svcs.concat(invs);
    window['_pfAcLista' + id] = lista;
    if (!lista.length) {
      ul.innerHTML = '<li style="color:var(--ink-faint);font-size:.78rem;padding:.5rem">Sin coincidencias — se guardará como ítem libre</li>';
      return;
    }
    ul.innerHTML = lista.map(function (x, i) {
      var esInv = x._tipo === 'inventario';
      var stock = esInv ? ' · 📦 ' + esc(x.cantidad) + ' ' + esc(x.unidad || '') : '';
      return '<li onmousedown="pfSelAc(event,' + id + ',' + i + ')">' +
        '<span class="ac-cat-pill" style="background:' + (esInv ? '#f0f9ff;color:#0369a1' : '#f0fdf4;color:#15803d') + '">' +
          esc(esInv ? (x.categoria || 'producto') : (x.categoria || 'servicio')) + '</span>' +
        '<span style="flex:1;font-weight:600">' + esc(x.nombre) + '</span>' +
        '<span style="font-size:.7rem;color:var(--ink-faint)">' + pfMoney(x.precio) + stock + '</span></li>';
    }).join('');
  }, 250);
}

function pfSelAc(e, id, i) {
  e.preventDefault();
  var x = (window['_pfAcLista' + id] || [])[i];
  if (!x) return;
  var row = document.getElementById('pf-item-' + id);
  row.querySelector('[data-f="desc"]').value = x.nombre;
  row.querySelector('[data-f="pu"]').value   = parseFloat(x.precio) || 0;
  row.querySelector('[data-f="svc-id"]').value = x._tipo === 'servicio'   ? x.id : '';
  row.querySelector('[data-f="inv-id"]').value = x._tipo === 'inventario' ? x.id : '';
  document.getElementById('pf-ac-' + id).style.display = 'none';
  pfCalcular();
}

document.addEventListener('click', function (e) {
  document.querySelectorAll('#pf-items .ac-factura-list').forEach(function (ul) {
    if (!ul.contains(e.target) && !(ul.previousElementSibling && ul.previousElementSibling.contains(e.target))) ul.style.display = 'none';
  });
});

function pfLeerItems() {
  var items = [];
  document.querySelectorAll('#pf-items > div').forEach(function (row) {
    items.push({
      descripcion  : row.querySelector('[data-f="desc"]').value.trim(),
      cantidad     : parseFloat(row.querySelector('[data-f="cant"]').value) || 0,
      precio_unit  : parseFloat(row.querySelector('[data-f="pu"]').value)   || 0,
      descuento_pct: parseFloat(row.querySelector('[data-f="dpct"]').value) || 0,
      servicio_id  : parseInt(row.querySelector('[data-f="svc-id"]').value) || null,
      inventario_id: parseInt(row.querySelector('[data-f="inv-id"]').value) || null,
    });
  });
  return items;
}

// Misma fórmula que el backend y que Facturación
function pfCalcular() {
  var igvPctNum = parseFloat((typeof empresa !== 'undefined' && empresa.igv_porcentaje) || 18);
  var igvPct = igvPctNum / 100;
  var bruto = 0, descItems = 0;
  pfLeerItems().forEach(function (it) {
    var b = it.cantidad * it.precio_unit;
    bruto += b;
    descItems += b * Math.min(Math.max(it.descuento_pct, 0), 100) / 100;
  });
  bruto = +bruto.toFixed(2); descItems = +descItems.toFixed(2);
  var dg = Math.min(Math.max(parseFloat(document.getElementById('pf-desc-global').value) || 0, 0), 100);
  var base = +(bruto - descItems).toFixed(2);
  var descG = +(base * dg / 100).toFixed(2);
  var final = +(base - descG).toFixed(2);
  var sub, igv, total;
  if (document.getElementById('pf-igv').checked) {
    sub = +(final / (1 + igvPct)).toFixed(2); igv = +(final - sub).toFixed(2); total = final;
  } else {
    sub = final; igv = +(sub * igvPct).toFixed(2); total = +(sub + igv).toFixed(2);
  }
  document.getElementById('pf-t-bruto').textContent = pfMoney(bruto);
  var totDesc = +(descItems + descG).toFixed(2);
  document.getElementById('pf-row-desc').style.display = totDesc > 0 ? 'flex' : 'none';
  document.getElementById('pf-t-desc').textContent = '−' + pfMoney(totDesc);
  document.getElementById('pf-t-sub').textContent  = pfMoney(sub);
  document.getElementById('pf-t-igv-lbl').textContent = 'IGV (' + igvPctNum + '%):';
  document.getElementById('pf-t-igv').textContent  = pfMoney(igv);
  document.getElementById('pf-t-total').textContent = pfMoney(total);
}

async function guardarProforma() {
  if (!_pfPropSel) { toast('Selecciona un propietario.', 'warning'); return; }
  var items = pfLeerItems();
  if (!items.length) { toast('Agrega al menos un ítem.', 'warning'); return; }
  for (var i = 0; i < items.length; i++) {
    if (!items[i].descripcion) { toast('Completa la descripción de todos los ítems.', 'warning'); return; }
    if (items[i].cantidad <= 0) { toast('La cantidad debe ser mayor a 0.', 'warning'); return; }
  }
  var validez = parseInt(document.getElementById('pf-validez').value);
  if (!validez || validez < 1 || validez > 365) { toast('La validez debe estar entre 1 y 365 días.', 'warning'); return; }
  var fecha = document.getElementById('pf-fecha').value;
  if (!fecha) { toast('Indica la fecha.', 'warning'); return; }

  var body = {
    propietario_id      : _pfPropSel.id,
    mascota_id          : parseInt(document.getElementById('pf-mascota').value) || null,
    historia_clinica_id : _pfOrigenHist,
    fecha               : fecha,
    validez_dias        : validez,
    igv_incluido        : document.getElementById('pf-igv').checked,
    descuento_global_pct: parseFloat(document.getElementById('pf-desc-global').value) || 0,
    notas               : document.getElementById('pf-notas').value.trim() || null,
    condiciones         : document.getElementById('pf-condiciones').value.trim() || null,
    items               : items,
  };

  var btn = document.getElementById('pf-btn-guardar');
  btn.disabled = true;
  try {
    var res = _pfEditId
      ? await api('/proformas/' + _pfEditId, { method: 'PUT', body: body })
      : await api('/proformas', { method: 'POST', body: body });
    var d = await pfJson(res);
    if (!res || !res.ok) { toast(d.message || 'No se pudo guardar.', 'danger'); return; }
    toast('✅ ' + (d.message || 'Proforma guardada.'), 'success');
    closeModal('modal-proforma');
    var id = _pfEditId || (d.data && d.data.id);
    pfRefrescar();
    if (id) verProforma(id);
  } catch (e) {
    toast('Error de conexión.', 'danger');
  } finally { btn.disabled = false; }
}

// ══════════════════════════════════════════════════════════════════
// 4. Ver proforma + acciones de estado
// ══════════════════════════════════════════════════════════════════
async function verProforma(id) {
  pfMontarUI();
  await pfCargarConfig();
  document.getElementById('pf-ver-titulo').textContent = '📝 Cargando…';
  document.getElementById('pf-preview').innerHTML = '<div class="vempty"><div class="vspinner"></div></div>';
  document.getElementById('pf-ver-acciones').innerHTML = '';
  document.getElementById('pf-ver-estado').innerHTML = '';
  openModal('modal-ver-proforma');

  var res = await api('/proformas/' + id);
  var d = await pfJson(res);
  if (!res || !res.ok) { toast(d.message || 'No se pudo cargar.', 'danger'); closeModal('modal-ver-proforma'); return; }
  _pfActual = d.data;
  var p = _pfActual;

  document.getElementById('pf-ver-titulo').textContent = '📝 Proforma ' + p.numero;

  // Línea de estado
  var info = pfBadge(p.estado);
  var dias = pfDiasRestantes(p.validez_hasta);
  if (['borrador', 'enviada', 'aceptada'].indexOf(p.estado) >= 0 && dias !== null) {
    info += ' <span style="font-size:.75rem;color:' + (dias <= 3 ? '#b45309' : 'var(--ink-soft)') + '">' +
            (dias < 0 ? 'Venció' : dias === 0 ? 'Vence hoy' : 'Vence en ' + dias + ' día(s)') + ' · ' + pfFecha(p.validez_hasta) + '</span>';
  }
  if (p.estado === 'rechazada' && p.motivo_rechazo)
    info += '<div style="font-size:.75rem;color:#be123c;margin-top:.35rem">Motivo: ' + esc(p.motivo_rechazo) + '</div>';
  if (p.estado === 'facturada' && p.factura_numero)
    info += '<div style="font-size:.75rem;color:#6d28d9;margin-top:.35rem">Convertida en ' + esc(p.factura_tipo || 'comprobante') +
            ' <b style="font-family:monospace">' + esc(p.factura_numero) + '</b>' +
            (p.factura_id ? ' · <button class="vlink" style="font-size:.75rem" onclick="closeModal(\'modal-ver-proforma\');verFactura(' + p.factura_id + ')">ver comprobante</button>' : '') + '</div>';
  document.getElementById('pf-ver-estado').innerHTML = info;

  // Botones según estado
  var B = function (txt, fn, estilo) {
    return '<button class="vbtn ' + (estilo ? '' : 'vbtn-ghost') + '" style="font-size:.78rem;padding:.4rem .8rem;' + (estilo || '') + '" onclick="' + fn + '">' + txt + '</button>';
  };
  var acc = [];
  var e = p.estado;
  if (['borrador', 'enviada', 'aceptada', 'vencida'].indexOf(e) >= 0)
    acc.push(B('🧾 Convertir en boleta/factura', 'convertirProforma(' + p.id + ')', 'background:linear-gradient(135deg,#15803d,#166534);color:#fff;border:none'));
  if (['borrador', 'enviada', 'vencida'].indexOf(e) >= 0) acc.push(B('✏️ Editar', 'editarProforma(' + p.id + ')'));
  if (e === 'borrador')  acc.push(B('📤 Marcar enviada', 'pfCambiarEstado(\'enviada\')'));
  if (e === 'borrador' || e === 'enviada') acc.push(B('👍 Aceptada', 'pfCambiarEstado(\'aceptada\')'));
  if (['borrador', 'enviada', 'aceptada', 'vencida'].indexOf(e) >= 0) acc.push(B('👎 Rechazada', 'pfAbrirRechazo()'));
  if (e === 'rechazada') acc.push(B('↩️ Reabrir', 'pfCambiarEstado(\'borrador\')'));
  acc.push(B('📄 Duplicar', 'pfDuplicar()'));
  if (e === 'borrador')  acc.push(B('🗑️ Eliminar', 'pfEliminar()', 'color:#be123c;border:1px solid #fecdd3;background:#fff'));
  document.getElementById('pf-ver-acciones').innerHTML = acc.join('');

  document.getElementById('pf-preview').innerHTML = pfDocumentoHTML(p, typeof empresa !== 'undefined' ? empresa : {});
}

async function pfCambiarEstado(estado, motivo) {
  if (!_pfActual) return;
  var res = await api('/proformas/' + _pfActual.id + '/estado', { method: 'PATCH', body: { estado: estado, motivo_rechazo: motivo || null } });
  var d = await pfJson(res);
  if (!res || !res.ok) { toast(d.message || 'No se pudo actualizar.', 'danger'); return false; }
  toast('✅ ' + d.message, 'success');
  pfRefrescar();
  await verProforma(_pfActual.id);
  return true;
}

function pfAbrirRechazo() {
  document.getElementById('pf-motivo').value = '';
  openModal('modal-pf-rechazo');
}

async function pfConfirmarRechazo() {
  var m = document.getElementById('pf-motivo').value.trim();
  if (!m) { toast('Indica el motivo.', 'warning'); return; }
  closeModal('modal-pf-rechazo');
  await pfCambiarEstado('rechazada', m);
}

function pfDuplicar() {
  if (!_pfActual) return;
  var p = _pfActual;
  pfConfirmar('📄 Duplicar proforma',
    'Se creará una nueva proforma en borrador con los mismos ítems y precios de ' + p.numero + ', con fecha de hoy.',
    'Duplicar', false, async function () {
      var res = await api('/proformas/' + p.id + '/duplicar', { method: 'POST' });
      var d = await pfJson(res);
      if (!res || !res.ok) { toast(d.message || 'No se pudo duplicar.', 'danger'); return; }
      toast('✅ ' + d.message, 'success');
      pfRefrescar();
      verProforma(d.data.id);
    });
}

function pfEliminar() {
  if (!_pfActual) return;
  var p = _pfActual;
  pfConfirmar('🗑️ Eliminar proforma',
    '¿Eliminar la proforma ' + p.numero + '? Esta acción no se puede deshacer.',
    'Eliminar', true, async function () {
      var res = await api('/proformas/' + p.id, { method: 'DELETE' });
      var d = await pfJson(res);
      if (!res || !res.ok) { toast(d.message || 'No se pudo eliminar.', 'danger'); return; }
      toast('🗑️ ' + d.message, 'success');
      closeModal('modal-ver-proforma');
      pfRefrescar();
    });
}

// ══════════════════════════════════════════════════════════════════
// 5. Documento imprimible
// ══════════════════════════════════════════════════════════════════
function pfDocumentoHTML(p, emp) {
  emp = emp || {};
  var igvPct = parseFloat(emp.igv_porcentaje || 18);
  var desc = parseFloat(p.descuento_items || 0) + parseFloat(p.descuento_global || 0);

  var filas = (p.items || []).map(function (it, i) {
    return '<tr>' +
      '<td style="padding:.45rem .6rem;border-bottom:1px solid #eef2ef;font-size:.75rem;color:#6b7c74">' + (i + 1) + '</td>' +
      '<td style="padding:.45rem .6rem;border-bottom:1px solid #eef2ef;font-size:.78rem">' + esc(it.descripcion) +
        (parseFloat(it.descuento_pct) > 0 ? ' <span style="font-size:.65rem;color:#be123c">(−' + parseFloat(it.descuento_pct) + '%)</span>' : '') + '</td>' +
      '<td style="padding:.45rem .6rem;border-bottom:1px solid #eef2ef;font-size:.78rem;text-align:center">' + parseFloat(it.cantidad) + '</td>' +
      '<td style="padding:.45rem .6rem;border-bottom:1px solid #eef2ef;font-size:.78rem;text-align:right">' + pfMoney(it.precio_unit) + '</td>' +
      '<td style="padding:.45rem .6rem;border-bottom:1px solid #eef2ef;font-size:.78rem;text-align:right;font-weight:600">' + pfMoney(it.subtotal) + '</td>' +
    '</tr>';
  }).join('');

  var fila = function (lbl, val, estilo) {
    return '<div style="display:flex;justify-content:space-between;gap:2rem;' + (estilo || '') + '"><span>' + lbl + '</span><span>' + val + '</span></div>';
  };

  return '' +
    '<div style="font-family:Inter,system-ui,sans-serif;color:#111">' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;border-bottom:3px solid #166534;padding-bottom:1rem;margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:.75rem">' +
        (emp.logo_url ? '<img src="' + esc(emp.logo_url) + '" crossorigin="anonymous" style="height:56px;object-fit:contain" onerror="this.style.display=\'none\'"/>' : '') +
        '<div><p style="font-weight:800;font-size:1rem;color:#166534">' + esc(emp.nombre || 'Clínica veterinaria') + '</p>' +
          (emp.razon_social ? '<p style="font-size:.72rem;color:#4b5f57">' + esc(emp.razon_social) + '</p>' : '') +
          (emp.ruc ? '<p style="font-size:.72rem;color:#4b5f57">RUC: ' + esc(emp.ruc) + '</p>' : '') +
          (emp.direccion ? '<p style="font-size:.7rem;color:#4b5f57">📍 ' + esc(emp.direccion) + (emp.distrito ? ', ' + esc(emp.distrito) : '') + '</p>' : '') +
          (emp.telefono ? '<p style="font-size:.7rem;color:#4b5f57">📞 ' + esc(emp.telefono) + '</p>' : '') +
        '</div>' +
      '</div>' +
      '<div style="text-align:right">' +
        '<div style="background:linear-gradient(135deg,#0f766e,#115e59);color:#fff;padding:.5rem 1rem;border-radius:.6rem;font-weight:800;font-size:.85rem;letter-spacing:.05em">PROFORMA</div>' +
        '<p style="font-family:monospace;font-weight:700;font-size:.85rem;margin-top:.35rem">' + esc(p.numero) + '</p>' +
        '<p style="font-size:.7rem;color:#4b5f57">Fecha: ' + pfFecha(p.fecha) + '</p>' +
        '<p style="font-size:.7rem;color:#b45309;font-weight:700">Válida hasta: ' + pfFecha(p.validez_hasta) + '</p>' +
      '</div>' +
    '</div>' +

    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:.7rem;padding:.75rem 1rem;margin-bottom:1rem;font-size:.75rem">' +
      '<div><p style="font-size:.6rem;color:#15803d;font-weight:700;text-transform:uppercase;letter-spacing:.08em">Cliente</p>' +
        '<p style="font-weight:700">' + esc(p.propietario_nombre) + '</p>' +
        (p.dni ? '<p style="color:#4b5f57">DNI: ' + esc(p.dni) + '</p>' : '') +
        (p.telefono ? '<p style="color:#4b5f57">Tel: ' + esc(p.telefono) + '</p>' : '') + '</div>' +
      '<div><p style="font-size:.6rem;color:#15803d;font-weight:700;text-transform:uppercase;letter-spacing:.08em">Paciente</p>' +
        '<p style="font-weight:700">' + esc(p.mascota_nombre || '—') + '</p>' +
        (p.mascota_especie ? '<p style="color:#4b5f57">' + esc(p.mascota_especie) + (p.mascota_raza ? ' · ' + esc(p.mascota_raza) : '') + '</p>' : '') + '</div>' +
    '</div>' +

    '<table style="width:100%;border-collapse:collapse;margin-bottom:1rem">' +
      '<thead><tr style="background:#166534;color:#fff">' +
        '<th style="padding:.5rem .6rem;text-align:left;font-size:.7rem">#</th>' +
        '<th style="padding:.5rem .6rem;text-align:left;font-size:.7rem">Descripción</th>' +
        '<th style="padding:.5rem .6rem;text-align:center;font-size:.7rem">Cant.</th>' +
        '<th style="padding:.5rem .6rem;text-align:right;font-size:.7rem">P. Unit.</th>' +
        '<th style="padding:.5rem .6rem;text-align:right;font-size:.7rem">Importe</th>' +
      '</tr></thead><tbody>' + filas + '</tbody></table>' +

    '<div style="display:flex;justify-content:flex-end;margin-bottom:1rem"><div style="min-width:240px;font-size:.78rem;display:flex;flex-direction:column;gap:.2rem">' +
      (desc > 0 ? fila('Subtotal bruto', pfMoney(p.subtotal_bruto), 'color:#4b5f57') + fila('Descuentos', '−' + pfMoney(desc), 'color:#be123c') : '') +
      fila('Op. gravada', pfMoney(p.subtotal), 'color:#4b5f57') +
      fila('IGV (' + igvPct + '%)', pfMoney(p.igv), 'color:#4b5f57') +
      fila('TOTAL', pfMoney(p.total), 'font-size:1rem;font-weight:800;color:#15803d;border-top:2px solid #bbf7d0;padding-top:.3rem;margin-top:.15rem') +
    '</div></div>' +

    (p.notas ? '<div style="background:#f8faf8;border-left:3px solid #15803d;padding:.6rem .8rem;font-size:.75rem;margin-bottom:.8rem;white-space:pre-line">' +
      '<b>Notas:</b> ' + esc(p.notas) + '</div>' : '') +
    (p.condiciones ? '<div style="font-size:.66rem;color:#6b7c74;border-top:1px dashed #d1d9d4;padding-top:.6rem;white-space:pre-line">' +
      '<b>Condiciones:</b> ' + esc(p.condiciones) + '</div>' : '') +
    '<p style="font-size:.62rem;color:#9aa8a1;text-align:center;margin-top:.8rem">Documento sin valor tributario · Atendido por ' + esc(p.creado_por_nombre || '—') + '</p>' +
    '</div>';
}

function pfImprimir() {
  if (!_pfActual) return;
  var html = document.getElementById('pf-preview').innerHTML;
  var w = window.open('', '_blank');
  if (!w) { toast('Permite las ventanas emergentes para imprimir.', 'warning'); return; }
  w.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + esc(_pfActual.numero) + '</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet"/>' +
    '<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Inter,sans-serif;padding:2rem;max-width:760px;margin:0 auto}' +
    '@media print{.no-print{display:none}body{padding:0}}</style></head><body>' + html +
    '<div class="no-print" style="text-align:center;margin-top:1.5rem"><button onclick="window.print()" ' +
    'style="background:#166534;color:#fff;border:none;padding:.6rem 1.5rem;border-radius:.5rem;font-weight:700;cursor:pointer">🖨️ Imprimir / Guardar PDF</button></div>' +
    '</body></html>');
  w.document.close();
  setTimeout(function () { w.print(); }, 700);
}

// ══════════════════════════════════════════════════════════════════
// 6. Enviar por WhatsApp (gateway si está conectado; si no, wa.me)
//    Si estaba en borrador, pasa automáticamente a "enviada".
// ══════════════════════════════════════════════════════════════════
async function pfEnviarWhatsApp() {
  if (!_pfActual) return;
  var p = _pfActual;
  var tel = String(p.telefono || '').replace(/\D/g, '');
  var telPE = tel ? (tel.indexOf('51') === 0 && tel.length > 9 ? tel : '51' + tel) : '';
  var btn = document.getElementById('pf-btn-wa');
  var original = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Preparando…';

  var mensaje = '🐾 *Proforma ' + p.numero + '*\n\n' +
    (p.mascota_nombre ? '🐶 Paciente: ' + p.mascota_nombre + '\n' : '') +
    '💰 Total: ' + pfMoney(p.total) + '\n' +
    '📅 Válida hasta: ' + pfFecha(p.validez_hasta) + '\n\n' +
    'Quedamos atentos a su confirmación. ¡Gracias! 🙏';

  var marcarEnviada = async function () {
    if (p.estado === 'borrador') await pfCambiarEstado('enviada');
  };

  try {
    var canvas = typeof html2canvas === 'function'
      ? await html2canvas(document.getElementById('pf-preview'), { scale: 2, useCORS: true, backgroundColor: '#ffffff' })
      : null;

    // 1) Intentar por el gateway de la clínica
    var est = await api('/wa/estado');
    var estD = est && est.ok ? await est.json() : null;
    if (estD && estD.data && estD.data.estado === 'conectado' && telPE && canvas) {
      var res = await api('/wa/enviar', { method: 'POST', body: {
        telefono: telPE, mensaje: mensaje,
        imagen_base64: canvas.toDataURL('image/png').split(',')[1], imagen_mimetype: 'image/png',
        propietario_id: p.propietario_id,
      } });
      var d = await pfJson(res);
      if (res && res.ok && d.success) {
        toast('✅ Proforma enviada por WhatsApp a +' + telPE, 'success', 5000);
        await marcarEnviada();
        return;
      }
      if (res && res.status !== 403) { toast('❌ No se pudo enviar: ' + (d.message || 'error'), 'danger', 6000); return; }
      // 403 (rol sin permiso para el gateway) → seguimos con el enlace directo
    }

    // 2) Enlace directo: descarga la imagen y abre WhatsApp con el texto
    if (!telPE) toast('El cliente no tiene teléfono registrado — elige el contacto en WhatsApp.', 'info', 4000);
    if (canvas) {
      var a = document.createElement('a');
      a.download = p.numero + '.png';
      a.href = canvas.toDataURL('image/png');
      a.click();
    }
    var txt = encodeURIComponent(mensaje + (canvas ? '\n\n(Adjunto la proforma en imagen)' : ''));
    window.open(telPE ? 'https://wa.me/' + telPE + '?text=' + txt : 'https://wa.me/?text=' + txt, '_blank');
    toast('Imagen descargada · adjúntala en el chat de WhatsApp', 'success', 5000);
    await marcarEnviada();
  } catch (e) {
    toast('Error al preparar el envío.', 'danger');
  } finally {
    btn.disabled = false; btn.innerHTML = original;
  }
}

// ══════════════════════════════════════════════════════════════════
// 7. Convertir en boleta/factura → abre el formulario de Facturación lleno
// ══════════════════════════════════════════════════════════════════
async function convertirProforma(id) {
  var res = await api('/proformas/' + id);
  var d = await pfJson(res);
  if (!res || !res.ok) { toast(d.message || 'No se pudo cargar la proforma.', 'danger'); return; }
  var p = d.data;
  if (p.estado === 'facturada') { toast('Esta proforma ya fue facturada (' + (p.factura_numero || '') + ').', 'warning'); return; }
  if (p.estado === 'rechazada') { toast('Reabre la proforma antes de facturarla.', 'warning'); return; }

  var seguir = async function () {
    closeModal('modal-ver-proforma');
    var rp = await api('/propietarios/' + p.propietario_id);
    var prop = rp && rp.ok ? (await rp.json()).data : null;
    if (!prop) { toast('No se pudo cargar el propietario.', 'danger'); return; }

    limpiarFormFac();
    window._proformaOrigenId = p.id;
    openModal('modal-factura');

    await selPropFac(prop.id, prop.nombre || '', prop.apellido || '', prop.dni || '', prop.telefono || '');
    if (p.mascota_id) {
      var sm = document.getElementById('nf-mascota');
      if (sm) sm.value = String(p.mascota_id);
    }
    document.getElementById('nf-igv').checked = !!p.igv_incluido;
    document.getElementById('nf-igv').dispatchEvent(new Event('change'));
    document.getElementById('nf-desc-global').value = parseFloat(p.descuento_global_pct) || 0;
    document.getElementById('nf-notas').value = 'Según proforma ' + p.numero;

    (p.items || []).forEach(function (it) {
      addItem(it.descripcion, parseFloat(it.cantidad), parseFloat(it.precio_unit));
      var rows = document.querySelectorAll('#nf-items > div');
      var row = rows[rows.length - 1];
      row.querySelector('[data-f="dpct"]').value = parseFloat(it.descuento_pct) || 0;
      var inv = row.querySelector('[data-f="inv-id"]');
      if (inv) inv.value = it.inventario_id || 0;
    });
    addPagoFila();
    calcularTotales();

    // Aviso dentro del formulario
    var body = document.querySelector('#modal-factura .vmodal-body');
    var old = document.getElementById('nf-proforma-banner');
    if (old) old.remove();
    body.insertAdjacentHTML('afterbegin',
      '<div id="nf-proforma-banner" style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:.85rem;padding:.7rem 1rem;font-size:.8rem;color:#6d28d9">' +
      '📝 Generando comprobante desde la proforma <b style="font-family:monospace">' + esc(p.numero) + '</b> (' + pfMoney(p.total) + '). ' +
      'Puedes ajustar ítems o cantidades antes de emitir. Al emitir, se descuenta el stock y la proforma queda como <b>facturada</b>.</div>');
  };

  if (p.estado === 'vencida') {
    pfConfirmar('⌛ Proforma vencida',
      'La proforma ' + p.numero + ' venció el ' + pfFecha(p.validez_hasta) + '. Los precios podrían haber cambiado. ¿Facturar igual con los precios cotizados?',
      'Facturar igual', false, seguir);
  } else {
    await seguir();
  }
}

// ══════════════════════════════════════════════════════════════════
// 8. Llegada desde la Historia Clínica (botón "Generar proforma")
// ══════════════════════════════════════════════════════════════════
(function pfDesdeHistoria() {
  var raw = null;
  try { raw = sessionStorage.getItem('proforma_desde_historia'); } catch (e) {}
  if (!raw) return;
  try { sessionStorage.removeItem('proforma_desde_historia'); } catch (e) {}
  var datos = null;
  try { datos = JSON.parse(raw); } catch (e) { return; }
  if (!datos || !datos.mascota_id) return;

  window.addEventListener('load', function () {
    setTimeout(async function () {
      if (typeof mostrarTab === 'function') mostrarTab('proformas');
      try {
        var res = await api('/mascotas/' + datos.mascota_id);
        var m = res && res.ok ? (await res.json()).data : null;
        if (!m) { toast('No se encontró la mascota.', 'danger'); return; }
        await abrirNuevaProforma({
          propietario_id     : m.propietario_id,
          mascota_id         : m.id,
          historia_clinica_id: datos.historia_clinica_id || null,
          notas              : datos.motivo ? 'Atención: ' + datos.motivo : '',
        });
      } catch (e) { toast('No se pudo preparar la proforma.', 'danger'); }
    }, 300);
  });
})();