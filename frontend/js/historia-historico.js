/* VetNetcodip — Histórico general de atenciones y seguimientos (Historia Clínica)
 *
 * Se ve en historia.html cuando no hay un paciente seleccionado.
 * Lista atenciones y seguimientos de TODAS las mascotas por rango de fechas,
 * con quién atendió y el motivo. Click en una fila → abre la historia del paciente.
 *
 * Se carga DESPUÉS de historia.js. Usa: api, esc, toast, mascotaFotoHTML, getTZ, getLocale,
 *   cargarHistoria, verConsultaConId (historia.js)
 */

var HH_LIMIT    = 50;
var _hhRango    = 'ayer';   // hoy | ayer | 7d | 30d | rango
var _hhOffset   = 0;
var _hhFilas    = [];
var _hhVetsSel  = '';
var _hhTimerQ   = null;
var _hhReqId    = 0;        // descarta respuestas viejas si el usuario cambia filtros rápido

// ══ Fechas (zona horaria de la clínica) ══════════════════════════

function hhHoy() {
  return new Date().toLocaleDateString('en-CA', { timeZone: getTZ() }); // YYYY-MM-DD
}

function hhSumarDias(ymd, dias) {
  var p = ymd.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + dias));
  return d.toISOString().slice(0, 10);
}

function hhFechaKey(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: getTZ() });
}

function hhHora(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: getTZ() });
}

function hhTituloDia(ymd) {
  var hoy = hhHoy();
  var etiqueta = ymd === hoy ? 'Hoy' : ymd === hhSumarDias(hoy, -1) ? 'Ayer' : '';
  var p = ymd.split('-').map(Number);
  var txt = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)).toLocaleDateString(getLocale(), {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
  return etiqueta ? etiqueta + ' · ' + txt : txt.charAt(0).toUpperCase() + txt.slice(1);
}

function hhRangoActual() {
  var hoy = hhHoy();
  if (_hhRango === 'hoy') return { desde: hoy, hasta: hoy };
  if (_hhRango === 'ayer') { var a = hhSumarDias(hoy, -1); return { desde: a, hasta: a }; }
  if (_hhRango === '7d')  return { desde: hhSumarDias(hoy, -6),  hasta: hoy };
  if (_hhRango === '30d') return { desde: hhSumarDias(hoy, -29), hasta: hoy };
  var d = document.getElementById('hh-desde').value || hoy;
  var h = document.getElementById('hh-hasta').value || d;
  return { desde: d, hasta: h };
}

// ══ Filtros ══════════════════════════════════════════════════════

function hhSetRango(r) {
  _hhRango = r;
  document.querySelectorAll('#hh-chips [data-rango]').forEach(function(b) {
    var on = b.getAttribute('data-rango') === r;
    b.style.background  = on ? 'var(--green-600)' : '#fff';
    b.style.color       = on ? '#fff' : 'var(--ink-soft)';
    b.style.borderColor = on ? 'var(--green-600)' : 'var(--line)';
  });
  var rangoBox = document.getElementById('hh-rango-box');
  rangoBox.style.display = r === 'rango' ? 'flex' : 'none';
  if (r === 'rango') {
    var hoy = hhHoy();
    if (!document.getElementById('hh-desde').value) document.getElementById('hh-desde').value = hhSumarDias(hoy, -1);
    if (!document.getElementById('hh-hasta').value) document.getElementById('hh-hasta').value = hoy;
  }
  hhCargar(true);
}

function hhBuscarDebounce() {
  clearTimeout(_hhTimerQ);
  _hhTimerQ = setTimeout(function() { hhCargar(true); }, 350);
}

// ══ Carga ════════════════════════════════════════════════════════

async function hhCargar(reiniciar) {
  var cont = document.getElementById('hh-lista');
  if (!cont) return;
  var reqId = ++_hhReqId;
  if (reiniciar) {
    _hhOffset = 0;
    _hhFilas  = [];
    cont.innerHTML = '<div class="vempty"><div class="vspinner"></div><p>Cargando atenciones…</p></div>';
  }
  var r     = hhRangoActual();
  var tipo  = document.getElementById('hh-tipo').value;
  var vet   = document.getElementById('hh-vet').value;
  var q     = document.getElementById('hh-q').value.trim();
  var url   = '/historia/recientes?desde=' + r.desde + '&hasta=' + r.hasta +
              '&tipo=' + tipo + '&limit=' + HH_LIMIT + '&offset=' + _hhOffset +
              (vet ? '&veterinario_id=' + vet : '') + (q ? '&q=' + encodeURIComponent(q) : '');
  try {
    var res = await api(url);
    if (!res) return;
    var json = await res.json();
    if (reqId !== _hhReqId) return; // llegó una búsqueda más nueva
    if (!res.ok) { cont.innerHTML = '<p style="color:#e11d48;font-size:.82rem;padding:1rem">' + esc(json.message || 'Error al cargar.') + '</p>'; return; }

    _hhFilas  = _hhFilas.concat(json.data || []);
    _hhOffset += (json.data || []).length;

    hhPintarContadores(json.totales || {});
    hhPintarVets(json.veterinarios || [], vet);
    hhPintarLista(json.hay_mas);
  } catch (e) {
    cont.innerHTML = '<p style="color:#e11d48;font-size:.82rem;padding:1rem">Error de conexión.</p>';
  }
}

function hhPintarContadores(t) {
  var a = t.atenciones || 0, s = t.seguimientos || 0;
  document.getElementById('hh-contadores').innerHTML =
    '<span style="background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;font-size:.72rem;font-weight:700;padding:.25rem .7rem;border-radius:999px">🩺 ' + a + ' atención' + (a !== 1 ? 'es' : '') + '</span>' +
    '<span style="background:#f5f3ff;color:#6d28d9;border:1px solid #ddd6fe;font-size:.72rem;font-weight:700;padding:.25rem .7rem;border-radius:999px">🔄 ' + s + ' seguimiento' + (s !== 1 ? 's' : '') + '</span>';
}

function hhPintarVets(vets, seleccionado) {
  var sel = document.getElementById('hh-vet');
  var html = '<option value="">Todos los veterinarios</option>';
  vets.forEach(function(v) {
    html += '<option value="' + v.id + '"' + (String(v.id) === String(seleccionado) ? ' selected' : '') + '>🩺 ' + esc(v.nombre) + '</option>';
  });
  // Si el seleccionado ya no está en el rango, mantenerlo para no perder el filtro
  if (seleccionado && !vets.some(function(v) { return String(v.id) === String(seleccionado); })) {
    html += '<option value="' + esc(seleccionado) + '" selected>(veterinario seleccionado)</option>';
  }
  sel.innerHTML = html;
}

function hhFila(f) {
  var esSeg   = f.tipo === 'seguimiento';
  var hora    = hhHora(f.fecha);
  var sinHora = esSeg && hora === '00:00'; // los seguimientos se registran solo con fecha
  var badge = esSeg
    ? '<span style="background:#f5f3ff;color:#6d28d9;border:1px solid #ddd6fe;font-size:.62rem;font-weight:700;padding:.15rem .55rem;border-radius:999px;white-space:nowrap">🔄 Seguimiento</span>'
    : '<span style="background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;font-size:.62rem;font-weight:700;padding:.15rem .55rem;border-radius:999px;white-space:nowrap">🩺 Atención</span>';
  var cita = (!esSeg && f.cita_id)
    ? '<span style="background:#f0f9ff;color:#0369a1;border:1px solid #bae6fd;font-size:.6rem;font-weight:700;padding:.12rem .5rem;border-radius:999px">Cita #' + f.cita_id + '</span>' : '';
  var detalle = f.detalle
    ? '<p style="font-size:.74rem;color:var(--ink-soft);margin-top:.25rem;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">' +
        '<strong>' + (esSeg ? 'Evolución:' : 'Dx:') + '</strong> ' + esc(f.detalle) + '</p>'
    : '';

  return '<div class="hh-fila" data-mascota="' + f.mascota_id + '" ' +
    'style="display:flex;gap:.85rem;align-items:flex-start;padding:.85rem 1rem;background:#fff;border:1px solid var(--line);' +
    'border-left:4px solid ' + (esSeg ? '#8b5cf6' : '#10b981') + ';border-radius:.9rem;cursor:pointer;transition:all .15s" ' +
    'onmouseover="this.style.boxShadow=\'var(--shadow-md)\'" onmouseout="this.style.boxShadow=\'\'" ' +
    'onclick="hhAbrirPaciente(' + f.mascota_id + ')">' +
      '<span style="width:44px;height:44px;border-radius:.9rem;background:linear-gradient(135deg,var(--green-50),#e0f2fe);display:flex;align-items:center;justify-content:center;font-size:1.5rem;overflow:hidden;flex-shrink:0">' +
        mascotaFotoHTML({ id: f.mascota_id, especie: f.especie, nombre: f.mascota_nombre, foto_updated_at: f.foto_updated_at }) +
      '</span>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:.45rem;flex-wrap:wrap">' +
          badge + cita +
          '<span style="font-size:.7rem;color:var(--ink-faint);font-weight:600">' + (sinHora ? 'Sin hora' : '🕐 ' + hora) + '</span>' +
        '</div>' +
        '<p style="font-weight:700;font-size:.9rem;margin-top:.3rem">' + esc(f.mascota_nombre) +
          ' <span style="font-weight:500;color:var(--ink-faint);font-size:.75rem">· 👤 ' + esc(f.propietario_nombre || '—') + '</span></p>' +
        '<p style="font-size:.78rem;margin-top:.15rem"><strong>Motivo' + (esSeg ? ' de la atención' : '') + ':</strong> ' + esc(f.motivo || '—') + '</p>' +
        detalle +
        '<p style="font-size:.72rem;color:var(--green-600);font-weight:700;margin-top:.3rem">👨‍⚕️ Atendió: Dr(a). ' + esc(f.veterinario_nombre || '—') + '</p>' +
      '</div>' +
      '<button onclick="event.stopPropagation();hhVerDetalle(' + f.historia_id + ')" title="Ver detalle de la atención" ' +
        'style="flex-shrink:0;background:none;border:1px solid var(--line);border-radius:.65rem;padding:.35rem .6rem;font-size:.7rem;font-weight:600;color:var(--sky);cursor:pointer;font-family:inherit">👁️ Ver</button>' +
    '</div>';
}

function hhPintarLista(hayMas) {
  var cont = document.getElementById('hh-lista');
  if (!_hhFilas.length) {
    cont.innerHTML = '<div style="text-align:center;padding:2.5rem 1rem;color:var(--ink-faint);font-size:.85rem">' +
      '<span style="font-size:2rem;display:block;margin-bottom:.5rem">🗓️</span>Sin atenciones ni seguimientos en este periodo.</div>';
    return;
  }
  var html = '', diaActual = '';
  _hhFilas.forEach(function(f) {
    var dia = hhFechaKey(f.fecha);
    if (dia !== diaActual) {
      diaActual = dia;
      html += '<p style="font-size:.72rem;font-weight:700;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.08em;margin:' + (html ? '1rem' : '0') + ' 0 .5rem">' + hhTituloDia(dia) + '</p>';
    }
    html += hhFila(f);
  });
  if (hayMas) {
    html += '<div style="text-align:center;margin-top:1rem"><button onclick="hhCargar(false)" class="vbtn vbtn-ghost">⬇️ Cargar más</button></div>';
  }
  cont.innerHTML = '<div style="display:flex;flex-direction:column;gap:.55rem">' + html + '</div>';
}

// ══ Acciones ═════════════════════════════════════════════════════

function hhAbrirPaciente(mascotaIdSel) {
  cargarHistoria(mascotaIdSel);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function hhVerDetalle(historiaId) {
  if (typeof verConsultaConId === 'function') verConsultaConId(historiaId);
}

/** Vuelve del expediente de un paciente al histórico general. */
function volverHistorico() {
  mascotaId = null;
  document.getElementById('panel').style.display = 'none';
  document.getElementById('vacio').style.display = 'block';
  ['btn-nueva-consulta', 'btn-nueva-vacuna', 'btn-nueva-estetica', 'btn-volver-historico'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  hhCargar(true);
}

// ══ Init ═════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', function() {
  if (!document.getElementById('hh-lista')) return;
  // Si se llegó con un paciente (desde citas/calendario), no hace falta cargar el histórico aún
  hhSetRango(_hhRango);
});