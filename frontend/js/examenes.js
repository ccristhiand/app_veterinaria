/* VetNetcodip — Exámenes en atenciones y seguimientos
 *
 * Se carga en historia.html ANTES de historia.js.
 * Usa: api(), esc(), toast(), vconfirm(), openModal(), closeModal(), fDate(), tryRefresh(), getSedeActiva()  (shared.js)
 *      mascotaId (historia.js)
 *
 * Piezas:
 *   1. Bloque "🧪 Exámenes" dentro de los formularios (nueva atención, editar atención, seguimiento).
 *      Los exámenes se agregan en memoria y se guardan DESPUÉS de guardar la atención / seguimiento.
 *   2. Modal "Gestionar exámenes" (#modal-examenes) para ver, agregar, adjuntar y eliminar.
 *   3. Chips de exámenes en la línea de tiempo y en el detalle de la atención.
 *
 * Sin template literals anidados: HTML por concatenación + data-* + delegación de eventos.
 */

var EXA_MAX_MB   = 10;
var EXA_MIMES    = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
var EXA_ACCEPT   = '.pdf,.jpg,.jpeg,.png,.webp';
var EXA_CAT_INFO = {
  laboratorio : { icon: '🧪', label: 'Laboratorio',  color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
  imagenologia: { icon: '🩻', label: 'Imagenología', color: '#0f766e', bg: '#f0fdfa', border: '#99f6e4' },
};

var _exaCatalogo = null;
var _exaRowN     = 0;
var _mexHistoriaId = null;
var _mexSegId      = null;
var _mexLista      = [];

// ══ Utilidades ═══════════════════════════════════════════════════

function exaCatInfo(cat) {
  return EXA_CAT_INFO[cat] || { icon: '🧪', label: 'Examen', color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' };
}

function exaTamano(bytes) {
  var b = parseInt(bytes) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function exaIconoArchivo(mime) {
  return (mime || '').indexOf('pdf') !== -1 ? '📄' : '🖼️';
}

function exaValidarArchivo(file) {
  if (EXA_MIMES.indexOf(file.type) === -1) return '"' + file.name + '": solo se permiten PDF, JPG, PNG o WEBP.';
  if (file.size > EXA_MAX_MB * 1024 * 1024) return '"' + file.name + '" supera ' + EXA_MAX_MB + ' MB.';
  return null;
}

function exaHeaders() {
  var h = { 'X-Tenant-Host': window.location.hostname };
  var token = localStorage.getItem('vet_access');
  if (token) h['Authorization'] = 'Bearer ' + token;
  var sede = typeof getSedeActiva === 'function' ? getSedeActiva() : null;
  if (sede) h['X-Sede-Id'] = String(sede);
  return h;
}

/** fetch autenticado para multipart / blobs (api() de shared.js siempre manda JSON). */
async function exaFetch(path, opts) {
  opts = opts || {};
  var doFetch = function() {
    return fetch(API_URL + '/api/v1' + path, { method: opts.method || 'GET', headers: exaHeaders(), body: opts.body });
  };
  var res = await doFetch();
  if (res.status === 401 && typeof tryRefresh === 'function') {
    var ok = await tryRefresh();
    if (!ok) { logout(); return null; }
    res = await doFetch();
  }
  return res;
}

async function exaCargarCatalogo(force) {
  if (_exaCatalogo && !force) return _exaCatalogo;
  try {
    var res = await api('/examenes/catalogo');
    if (!res || !res.ok) return _exaCatalogo || [];
    _exaCatalogo = (await res.json()).data || [];
  } catch (e) { _exaCatalogo = _exaCatalogo || []; }
  return _exaCatalogo;
}

function exaOpcionesCatalogo() {
  var cat  = _exaCatalogo || [];
  var html = '<option value="">Seleccionar examen…</option>';
  ['laboratorio', 'imagenologia'].forEach(function(c) {
    var items = cat.filter(function(s) { return s.categoria === c; });
    if (!items.length) return;
    html += '<optgroup label="' + exaCatInfo(c).icon + ' ' + exaCatInfo(c).label + '">';
    items.forEach(function(s) {
      html += '<option value="' + s.id + '">' + esc(s.nombre) + '</option>';
    });
    html += '</optgroup>';
  });
  return html;
}

// ══ 1. Bloque "Exámenes" dentro de formularios ═══════════════════

/**
 * prefix: 'co' (nueva atención) | 'ec' (editar atención) | 'seg' (seguimiento) | 'mex' (modal gestionar)
 * Pinta el bloque en #<prefix>-examenes-wrap
 */
function examenesFormInit(prefix, opciones) {
  opciones = opciones || {};
  var wrap = document.getElementById(prefix + '-examenes-wrap');
  if (!wrap) return;
  var titulo = opciones.titulo || '🧪 Exámenes';
  var nota   = opciones.nota ? '<p style="font-size:.7rem;color:var(--ink-faint);margin:-.35rem 0 .6rem">' + opciones.nota + '</p>' : '';
  var borde  = opciones.sinBorde ? '' : 'border-top:1px solid var(--line);padding-top:1.1rem';

  wrap.innerHTML =
    '<div style="' + borde + '">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.8rem">' +
        '<label style="font-weight:700;font-size:.88rem;font-family:\'Playfair Display\',serif">' + titulo + '</label>' +
        '<button type="button" class="vlink" style="color:#1d4ed8" data-exa-action="add-row" data-prefix="' + prefix + '">＋ Agregar examen</button>' +
      '</div>' +
      nota +
      '<div id="' + prefix + '-examenes-list" style="display:flex;flex-direction:column;gap:.7rem"></div>' +
    '</div>';
}

function examenesFormReset(prefix) {
  var list = document.getElementById(prefix + '-examenes-list');
  if (list) list.innerHTML = '';
}

async function examenesAddRow(prefix) {
  await exaCargarCatalogo();
  if (!_exaCatalogo || !_exaCatalogo.length) {
    toast('No hay exámenes en el catálogo. Agrégalos en Servicios → pestaña Exámenes.', 'warning', 6000);
    return;
  }
  var list = document.getElementById(prefix + '-examenes-list');
  if (!list) return;
  var n   = _exaRowN++;
  var div = document.createElement('div');
  div.className = 'exa-row';
  div.id = 'exa-row-' + n;
  div.style.cssText = 'background:#f8fbff;border:1px solid #dbeafe;border-radius:1rem;padding:.9rem;display:flex;flex-direction:column;gap:.6rem';
  div.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<p style="font-size:.72rem;font-weight:700;color:#1d4ed8">🧪 Examen</p>' +
      '<button type="button" class="vlink" style="color:#e11d48" data-exa-action="remove-row" data-row="exa-row-' + n + '">Quitar</button>' +
    '</div>' +
    '<select class="vinput" data-exa="servicio" style="font-size:.8rem">' + exaOpcionesCatalogo() + '</select>' +
    '<textarea class="vinput" data-exa="obs" rows="2" style="font-size:.78rem" placeholder="Resultado / observaciones del examen (opcional)…"></textarea>' +
    '<div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap">' +
      '<label class="vbtn vbtn-ghost" style="font-size:.74rem;padding:.4rem .8rem;cursor:pointer">📎 Adjuntar archivos' +
        '<input type="file" multiple accept="' + EXA_ACCEPT + '" data-exa="files" data-exa-action="row-files" style="display:none"/>' +
      '</label>' +
      '<span style="font-size:.66rem;color:var(--ink-faint)">PDF, JPG, PNG · máx. ' + EXA_MAX_MB + ' MB c/u</span>' +
    '</div>' +
    '<div data-exa="files-preview" style="display:flex;flex-wrap:wrap;gap:.4rem"></div>';
  div._exaFiles = [];
  list.appendChild(div);
}

function exaPintarPreviewRow(row) {
  var prev = row.querySelector('[data-exa="files-preview"]');
  if (!prev) return;
  var html = '';
  (row._exaFiles || []).forEach(function(f, i) {
    html += '<span style="display:inline-flex;align-items:center;gap:.35rem;font-size:.7rem;background:#fff;border:1px solid #dbeafe;border-radius:999px;padding:.2rem .6rem">' +
      exaIconoArchivo(f.type) + ' ' + esc(f.name) + ' <span style="color:var(--ink-faint)">' + exaTamano(f.size) + '</span>' +
      '<button type="button" data-exa-action="row-file-remove" data-idx="' + i + '" style="border:none;background:none;color:#e11d48;cursor:pointer;font-size:.75rem;padding:0">✕</button>' +
    '</span>';
  });
  prev.innerHTML = html;
}

/** Lee y valida el bloque. Devuelve { items, error } */
function examenesFormLeer(prefix) {
  var items = [];
  var rows  = document.querySelectorAll('#' + prefix + '-examenes-list .exa-row');
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var svc = row.querySelector('[data-exa="servicio"]').value;
    if (!svc) return { items: [], error: 'Selecciona el examen o quita la fila vacía.' };
    items.push({
      servicio_id  : parseInt(svc),
      observaciones: row.querySelector('[data-exa="obs"]').value.trim() || null,
      files        : (row._exaFiles || []).slice(),
    });
  }
  return { items: items, error: null };
}

function examenesFormTienePendientes(prefix) {
  return document.querySelectorAll('#' + prefix + '-examenes-list .exa-row').length > 0;
}

async function exaSubirArchivo(examenId, file) {
  var fd = new FormData();
  fd.append('archivo', file);
  var res = await exaFetch('/examenes/' + examenId + '/archivos', { method: 'POST', body: fd });
  if (!res) return { ok: false, message: 'Sesión expirada.' };
  var data = {};
  try { data = await res.json(); } catch (e) {}
  return { ok: res.ok, message: data.message || '' };
}

/**
 * Guarda los exámenes del bloque ya validados.
 * Devuelve { registrados, errores }
 */
async function examenesGuardarItems(items, historiaId, seguimientoId) {
  var registrados = 0, errores = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    try {
      var res = await api('/examenes', {
        method: 'POST',
        body  : {
          historia_id   : historiaId,
          seguimiento_id: seguimientoId || null,
          servicio_id   : it.servicio_id,
          observaciones : it.observaciones,
        },
      });
      if (!res || !res.ok) { errores++; continue; }
      var exId = (await res.json()).data.id;
      registrados++;
      for (var j = 0; j < it.files.length; j++) {
        var up = await exaSubirArchivo(exId, it.files[j]);
        if (!up.ok) errores++;
      }
    } catch (e) { errores++; }
  }
  return { registrados: registrados, errores: errores };
}

/** Atajo: lee + guarda + limpia el bloque. Usado por historia.js después de guardar. */
async function examenesGuardarPendientes(prefix, historiaId, seguimientoId) {
  var leido = examenesFormLeer(prefix);
  if (leido.error || !leido.items.length) return { registrados: 0, errores: 0 };
  var r = await examenesGuardarItems(leido.items, historiaId, seguimientoId);
  examenesFormReset(prefix);
  if (r.errores) toast('⚠️ ' + r.errores + ' examen(es) o archivo(s) no se pudieron guardar. Revísalos en 🧪 Exámenes.', 'warning', 6000);
  return r;
}

// ══ 2. Modal "Gestionar exámenes" ════════════════════════════════

async function abrirModalExamenes(historiaId, seguimientoId) {
  _mexHistoriaId = historiaId;
  _mexSegId      = seguimientoId || null;
  document.getElementById('mex-titulo').textContent = seguimientoId ? '🧪 Exámenes del seguimiento' : '🧪 Exámenes de la atención';
  examenesFormInit('mex', { titulo: '➕ Registrar nuevos exámenes', sinBorde: true });
  document.getElementById('mex-lista').innerHTML = '<div class="vempty"><div class="vspinner"></div></div>';
  openModal('modal-examenes');
  exaCargarCatalogo();
  await exaRecargarModal();
}

async function exaRecargarModal() {
  var cont = document.getElementById('mex-lista');
  if (!cont || !_mexHistoriaId) return;
  try {
    var res = await api('/examenes?historia_id=' + _mexHistoriaId);
    if (!res || !res.ok) { cont.innerHTML = '<p style="color:#e11d48;font-size:.82rem">Error al cargar exámenes.</p>'; return; }
    var todos = (await res.json()).data || [];
    var lista = todos.filter(function(e) {
      return _mexSegId ? e.seguimiento_id === _mexSegId : !e.seguimiento_id;
    });
    _mexLista = lista;
    if (!lista.length) {
      cont.innerHTML = '<div style="text-align:center;padding:1.2rem;font-size:.8rem;color:var(--ink-faint);background:#f8faf8;border-radius:.9rem;border:1px dashed var(--line)">Sin exámenes registrados todavía.</div>';
      return;
    }
    var html = '';
    lista.forEach(function(e) { html += exaCardGestion(e); });
    cont.innerHTML = html;
  } catch (e) {
    cont.innerHTML = '<p style="color:#e11d48;font-size:.82rem">Error de conexión.</p>';
  }
}

function exaCardGestion(e) {
  var ci = exaCatInfo(e.categoria);
  var archivos = '';
  (e.archivos || []).forEach(function(a) {
    archivos +=
      '<span style="display:inline-flex;align-items:center;gap:.35rem;font-size:.72rem;background:#fff;border:1px solid var(--line);border-radius:999px;padding:.25rem .65rem">' +
        '<button type="button" data-exa-action="ver-archivo" data-id="' + a.id + '" style="border:none;background:none;cursor:pointer;font-family:inherit;font-size:.72rem;color:#1d4ed8;font-weight:600;padding:0">' +
          exaIconoArchivo(a.mime_type) + ' ' + esc(a.nombre_original) +
        '</button>' +
        '<span style="color:var(--ink-faint)">' + exaTamano(a.tamano_bytes) + '</span>' +
        '<button type="button" data-exa-action="del-archivo" data-id="' + a.id + '" title="Eliminar archivo" style="border:none;background:none;color:#e11d48;cursor:pointer;font-size:.75rem;padding:0">✕</button>' +
      '</span>';
  });
  if (!archivos) archivos = '<span style="font-size:.7rem;color:var(--ink-faint)">Sin archivos adjuntos</span>';

  return '<div style="background:#fff;border:1px solid ' + ci.border + ';border-radius:1rem;padding:.9rem;display:flex;flex-direction:column;gap:.55rem">' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;flex-wrap:wrap">' +
      '<div>' +
        '<p style="font-weight:700;font-size:.88rem">' + ci.icon + ' ' + esc(e.nombre_examen) + '</p>' +
        '<p style="font-size:.68rem;color:var(--ink-faint);margin-top:.15rem">' + fDate(e.fecha) + ' · ' + esc(e.registrado_por_nombre || '') + '</p>' +
      '</div>' +
      '<span style="font-size:.62rem;font-weight:700;padding:.15rem .5rem;border-radius:999px;background:' + ci.bg + ';color:' + ci.color + ';border:1px solid ' + ci.border + '">' + ci.label + '</span>' +
    '</div>' +
    '<div data-exa-obs-wrap="' + e.id + '">' +
      (e.observaciones
        ? '<p style="font-size:.78rem;line-height:1.5;white-space:pre-wrap">' + esc(e.observaciones) + '</p>'
        : '<p style="font-size:.74rem;color:var(--ink-faint)">Sin observaciones.</p>') +
    '</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:.4rem">' + archivos + '</div>' +
    '<div style="display:flex;gap:.9rem;align-items:center;padding-top:.5rem;border-top:1px solid var(--line);flex-wrap:wrap">' +
      '<label style="font-size:.72rem;color:#1d4ed8;font-weight:600;cursor:pointer">📎 Adjuntar' +
        '<input type="file" multiple accept="' + EXA_ACCEPT + '" data-exa-action="upload-exist" data-id="' + e.id + '" style="display:none"/>' +
      '</label>' +
      '<button type="button" data-exa-action="edit-obs" data-id="' + e.id + '" style="font-size:.72rem;color:var(--sky);background:none;border:none;cursor:pointer;font-family:inherit;font-weight:600;padding:0">✏️ Observaciones</button>' +
      '<button type="button" data-exa-action="del-examen" data-id="' + e.id + '" data-nombre="' + esc(e.nombre_examen) + '" style="font-size:.72rem;color:#e11d48;background:none;border:none;cursor:pointer;font-family:inherit;font-weight:600;padding:0">🗑️ Eliminar</button>' +
    '</div>' +
  '</div>';
}

async function guardarExamenesModal() {
  var leido = examenesFormLeer('mex');
  if (leido.error) { toast(leido.error, 'warning'); return; }
  if (!leido.items.length) { toast('Agrega al menos un examen con "＋ Agregar examen".', 'warning'); return; }
  var btn = document.getElementById('mex-btn-guardar');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    var r = await examenesGuardarItems(leido.items, _mexHistoriaId, _mexSegId);
    examenesFormReset('mex');
    if (r.errores) toast('⚠️ ' + r.errores + ' examen(es) o archivo(s) no se pudieron guardar.', 'warning', 6000);
    else toast('🧪 ' + r.registrados + ' examen(es) registrado(s).', 'success');
    await exaRecargarModal();
    exaRefrescarVistas();
  } finally {
    btn.disabled = false; btn.textContent = '💾 Guardar exámenes';
  }
}

async function exaSubirAExistente(examenId, files) {
  var subidos = 0, errores = 0;
  for (var i = 0; i < files.length; i++) {
    var err = exaValidarArchivo(files[i]);
    if (err) { toast(err, 'warning', 5000); errores++; continue; }
    var up = await exaSubirArchivo(examenId, files[i]);
    if (up.ok) subidos++;
    else { errores++; toast(up.message || 'Error al subir ' + files[i].name, 'danger'); }
  }
  if (subidos) toast('📎 ' + subidos + ' archivo(s) subido(s).', 'success');
  await exaRecargarModal();
  exaRefrescarVistas();
}

async function exaEliminarExamen(id, nombre) {
  var ok = await vconfirm({
    titulo : '¿Eliminar examen?',
    mensaje: 'Se eliminará <strong>' + esc(nombre || 'el examen') + '</strong> y todos sus archivos adjuntos. No se puede deshacer.',
    labelOk: '🗑️ Sí, eliminar',
    tipo   : 'danger',
  });
  if (!ok) return;
  try {
    var res = await api('/examenes/' + id, { method: 'DELETE' });
    if (!res) return;
    var data = await res.json();
    if (!res.ok) { toast(data.message || 'Error al eliminar.', 'danger'); return; }
    toast('🗑️ Examen eliminado.', 'success');
    await exaRecargarModal();
    exaRefrescarVistas();
  } catch (e) { toast('Error de conexión.', 'danger'); }
}

async function exaEliminarArchivo(id) {
  var ok = await vconfirm({
    titulo : '¿Eliminar archivo?',
    mensaje: 'El archivo se eliminará definitivamente.',
    labelOk: '🗑️ Eliminar',
    tipo   : 'danger',
  });
  if (!ok) return;
  try {
    var res = await api('/examenes/archivos/' + id, { method: 'DELETE' });
    if (!res) return;
    var data = await res.json();
    if (!res.ok) { toast(data.message || 'Error al eliminar.', 'danger'); return; }
    toast('🗑️ Archivo eliminado.', 'success');
    await exaRecargarModal();
    exaRefrescarVistas();
  } catch (e) { toast('Error de conexión.', 'danger'); }
}

function exaEditarObs(id) {
  var wrap = document.querySelector('[data-exa-obs-wrap="' + id + '"]');
  if (!wrap) return;
  var ex = _mexLista.find(function(x) { return x.id === id; });
  var actual = ex && ex.observaciones ? ex.observaciones : '';
  wrap.innerHTML =
    '<textarea class="vinput" rows="3" style="font-size:.78rem" data-exa-obs-input="' + id + '"></textarea>' +
    '<div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:.4rem">' +
      '<button type="button" class="vbtn vbtn-ghost" style="font-size:.72rem;padding:.35rem .8rem" data-exa-action="cancel-obs">Cancelar</button>' +
      '<button type="button" class="vbtn vbtn-primary" style="font-size:.72rem;padding:.35rem .8rem" data-exa-action="save-obs" data-id="' + id + '">💾 Guardar</button>' +
    '</div>';
  var ta = wrap.querySelector('textarea');
  ta.value = actual;
  ta.focus();
}

async function exaGuardarObs(id) {
  var ta = document.querySelector('[data-exa-obs-input="' + id + '"]');
  if (!ta) return;
  try {
    var res = await api('/examenes/' + id, { method: 'PUT', body: { observaciones: ta.value.trim() || null } });
    if (!res) return;
    var data = await res.json();
    if (!res.ok) { toast(data.message || 'Error.', 'danger'); return; }
    toast('✅ Observaciones actualizadas.', 'success');
    await exaRecargarModal();
    exaRefrescarVistas();
  } catch (e) { toast('Error de conexión.', 'danger'); }
}

/** Abre el archivo en una pestaña nueva (PDF / imagen) usando el token, sin exponer Azure. */
async function exaVerArchivo(archivoId) {
  // Abrir la pestaña ANTES del await para que el navegador no la bloquee como popup
  var w = window.open('', '_blank');
  if (w) {
    try { w.document.write('<p style="font-family:sans-serif;padding:2rem;color:#555">Cargando archivo…</p>'); } catch (e) {}
  }
  try {
    var res = await exaFetch('/examenes/archivos/' + archivoId);
    if (!res || !res.ok) {
      if (w) w.close();
      var msg = 'No se pudo abrir el archivo.';
      try { msg = (await res.json()).message || msg; } catch (e) {}
      toast(msg, 'danger');
      return;
    }
    var blob = await res.blob();
    var url  = URL.createObjectURL(blob);
    if (w) {
      w.location.href = url;
    } else {
      // Popup bloqueado → descarga directa
      var a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    }
    setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
  } catch (e) {
    if (w) w.close();
    toast('Error de conexión.', 'danger');
  }
}

// ══ 3. Chips en la línea de tiempo y en el detalle ═══════════════

/** Refresca chips de la línea de tiempo y, si está abierto, el detalle de la atención. */
function exaRefrescarVistas() {
  examenesPintarTimeline();
  var mv = document.getElementById('modal-ver');
  if (mv && !mv.classList.contains('hidden') && document.getElementById('ver-examenes') && _mexHistoriaId) {
    examenesPintarDetalle(_mexHistoriaId);
  }
}

function exaChip(e) {
  var ci = exaCatInfo(e.categoria);
  var n  = (e.archivos || []).length;
  return '<button type="button" data-exa-action="open-modal" data-historia="' + e.historia_id + '" data-seg="' + (e.seguimiento_id || '') + '" ' +
    'style="display:inline-flex;align-items:center;gap:.3rem;font-size:.66rem;font-weight:600;padding:.2rem .55rem;border-radius:999px;cursor:pointer;font-family:inherit;' +
    'background:' + ci.bg + ';color:' + ci.color + ';border:1px solid ' + ci.border + '" title="Ver exámenes">' +
    ci.icon + ' ' + esc(e.nombre_examen) + (n ? ' · 📎' + n : '') +
  '</button>';
}

/** Rellena los contenedores [data-exa-h] / [data-exa-s] que pinta historia.js en la línea de tiempo. */
async function examenesPintarTimeline() {
  if (typeof mascotaId === 'undefined' || !mascotaId) return;
  var hosts = document.querySelectorAll('[data-exa-h],[data-exa-s]');
  if (!hosts.length) return;
  try {
    var res = await api('/examenes?mascota_id=' + mascotaId);
    if (!res || !res.ok) return;
    var lista = (await res.json()).data || [];
    var porH = {}, porS = {};
    lista.forEach(function(e) {
      if (e.seguimiento_id) (porS[e.seguimiento_id] = porS[e.seguimiento_id] || []).push(e);
      else (porH[e.historia_id] = porH[e.historia_id] || []).push(e);
    });
    document.querySelectorAll('[data-exa-h]').forEach(function(el) {
      var arr = porH[el.getAttribute('data-exa-h')] || [];
      el.innerHTML = arr.map(exaChip).join('');
      el.style.display = arr.length ? 'flex' : 'none';
    });
    document.querySelectorAll('[data-exa-s]').forEach(function(el) {
      var arr = porS[el.getAttribute('data-exa-s')] || [];
      el.innerHTML = arr.map(exaChip).join('');
      el.style.display = arr.length ? 'flex' : 'none';
    });
  } catch (e) { /* silencioso: la historia sigue funcionando sin chips */ }
}

/** Detalle de la atención (modal-ver): todos sus exámenes, incluidos los de seguimientos. */
async function examenesPintarDetalle(historiaId) {
  var cont = document.getElementById('ver-examenes');
  if (!cont) return;
  try {
    var res = await api('/examenes?historia_id=' + historiaId);
    if (!res || !res.ok) { cont.innerHTML = ''; return; }
    var lista = (await res.json()).data || [];
    var html =
      '<div style="margin-top:1.2rem;background:linear-gradient(135deg,#eff6ff,#f0fdfa);border:1px solid #bfdbfe;border-radius:1.1rem;padding:1.15rem">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.85rem;gap:.5rem;flex-wrap:wrap">' +
          '<h4 style="font-family:\'Playfair Display\',serif;font-weight:700;color:#1e3a8a;font-size:.92rem">🧪 Exámenes (' + lista.length + ')</h4>' +
          '<button type="button" class="vlink" style="color:#1d4ed8;font-size:.74rem" data-exa-action="open-modal" data-historia="' + historiaId + '" data-seg="">＋ Gestionar</button>' +
        '</div>';
    if (!lista.length) {
      html += '<p style="font-size:.78rem;color:var(--ink-faint)">Sin exámenes registrados.</p>';
    } else {
      html += '<div style="display:flex;flex-direction:column;gap:.55rem">';
      lista.forEach(function(e) {
        var ci = exaCatInfo(e.categoria);
        var archivos = (e.archivos || []).map(function(a) {
          return '<button type="button" data-exa-action="ver-archivo" data-id="' + a.id + '" ' +
            'style="font-size:.7rem;background:#fff;border:1px solid var(--line);border-radius:999px;padding:.2rem .6rem;cursor:pointer;font-family:inherit;color:#1d4ed8;font-weight:600">' +
            exaIconoArchivo(a.mime_type) + ' ' + esc(a.nombre_original) + '</button>';
        }).join('');
        html +=
          '<div style="background:#fff;border-radius:.85rem;padding:.85rem 1rem;font-size:.8rem">' +
            '<div style="display:flex;justify-content:space-between;gap:.5rem;flex-wrap:wrap">' +
              '<p style="font-weight:700">' + ci.icon + ' ' + esc(e.nombre_examen) + '</p>' +
              '<span style="font-size:.66rem;color:var(--ink-faint)">' + fDate(e.fecha) + (e.seguimiento_id ? ' · 🔄 Seguimiento' : '') + '</span>' +
            '</div>' +
            (e.observaciones ? '<p style="color:var(--ink-soft);margin-top:.3rem;line-height:1.5;white-space:pre-wrap">' + esc(e.observaciones) + '</p>' : '') +
            (archivos ? '<div style="display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.5rem">' + archivos + '</div>' : '') +
          '</div>';
      });
      html += '</div>';
    }
    html += '</div>';
    cont.innerHTML = html;
  } catch (e) { cont.innerHTML = ''; }
}

// ══ Delegación de eventos ════════════════════════════════════════
// Fase de CAPTURA (true): así los chips dentro de la tarjeta de la línea de tiempo
// se atienden antes que el onclick de la tarjeta (que abre el detalle).

document.addEventListener('click', function(ev) {
  var el = ev.target.closest('[data-exa-action]');
  if (!el) return;
  var action = el.getAttribute('data-exa-action');
  if (action === 'row-files' || action === 'upload-exist') return; // son inputs file → evento change

  if (action === 'add-row') {
    ev.preventDefault();
    examenesAddRow(el.getAttribute('data-prefix'));
  } else if (action === 'remove-row') {
    ev.preventDefault();
    var row = document.getElementById(el.getAttribute('data-row'));
    if (row) row.remove();
  } else if (action === 'row-file-remove') {
    ev.preventDefault();
    var r = el.closest('.exa-row');
    if (r && r._exaFiles) { r._exaFiles.splice(parseInt(el.getAttribute('data-idx')), 1); exaPintarPreviewRow(r); }
  } else if (action === 'open-modal') {
    ev.preventDefault(); ev.stopPropagation();
    var seg = el.getAttribute('data-seg');
    abrirModalExamenes(parseInt(el.getAttribute('data-historia')), seg ? parseInt(seg) : null);
  } else if (action === 'ver-archivo') {
    ev.preventDefault(); ev.stopPropagation();
    exaVerArchivo(parseInt(el.getAttribute('data-id')));
  } else if (action === 'del-archivo') {
    ev.preventDefault();
    exaEliminarArchivo(parseInt(el.getAttribute('data-id')));
  } else if (action === 'del-examen') {
    ev.preventDefault();
    exaEliminarExamen(parseInt(el.getAttribute('data-id')), el.getAttribute('data-nombre'));
  } else if (action === 'edit-obs') {
    ev.preventDefault();
    exaEditarObs(parseInt(el.getAttribute('data-id')));
  } else if (action === 'save-obs') {
    ev.preventDefault();
    exaGuardarObs(parseInt(el.getAttribute('data-id')));
  } else if (action === 'cancel-obs') {
    ev.preventDefault();
    exaRecargarModal();
  }
}, true);

document.addEventListener('change', function(ev) {
  var el = ev.target;
  if (!el || !el.getAttribute) return;
  var action = el.getAttribute('data-exa-action');
  if (action === 'row-files') {
    var row = el.closest('.exa-row');
    if (!row) return;
    row._exaFiles = row._exaFiles || [];
    Array.prototype.forEach.call(el.files || [], function(f) {
      var err = exaValidarArchivo(f);
      if (err) { toast(err, 'warning', 5000); return; }
      row._exaFiles.push(f);
    });
    el.value = '';
    exaPintarPreviewRow(row);
  } else if (action === 'upload-exist') {
    var files = Array.prototype.slice.call(el.files || []);
    var id    = parseInt(el.getAttribute('data-id'));
    el.value  = '';
    if (files.length) exaSubirAExistente(id, files);
  }
});

// ══ Init: pintar bloques en los formularios ══════════════════════

document.addEventListener('DOMContentLoaded', function() {
  examenesFormInit('co');
  examenesFormInit('ec', { titulo: '🧪 Agregar exámenes', nota: 'Los exámenes ya registrados se gestionan con el botón 🧪 Exámenes de la línea de tiempo.' });
  examenesFormInit('seg');
});