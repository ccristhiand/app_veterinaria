/**
 * Excel de propietarios con sus mascotas (con filtros de Excel en las cabeceras).
 *
 * construirExcelPropietarios(XS, filas, opciones) → workbook
 *   XS     : librería xlsx-js-style (window.XLSX en el navegador, require('xlsx-js-style') en Node)
 *   filas  : respuesta de GET /propietarios/exportar (una fila por mascota)
 *   opciones.clinica : nombre de la clínica para el título (opcional)
 *
 * Hojas:
 *   1. "Propietarios y mascotas" — una fila por mascota (los datos del propietario se repiten,
 *      así se puede filtrar por especie, raza, sexo, etc. sin perder a quién pertenece).
 *   2. "Propietarios" — una fila por propietario con el número y nombres de sus mascotas.
 */
(function (root) {
  'use strict';

  var ESPECIES = { perro: 'Canino', gato: 'Felino', ave: 'Ave', reptil: 'Reptil', roedor: 'Roedor', otro: 'Otro' };
  var SEXOS    = { macho: 'Macho', hembra: 'Hembra', desconocido: 'Desconocido' };

  var VD = '166534', VC = 'ECFDF5', BL = 'FFFFFF', NG = '1A2E28';
  var borde = function (c) {
    var l = { style: 'thin', color: { rgb: c } };
    return { top: l, bottom: l, left: l, right: l };
  };
  var ESTILOS = {
    titulo: { font: { bold: true, sz: 13, color: { rgb: BL } }, fill: { fgColor: { rgb: VD } },
              alignment: { horizontal: 'left', vertical: 'center' } },
    info:   { font: { italic: true, sz: 9, color: { rgb: '4B5F57' } }, fill: { fgColor: { rgb: VC } } },
    hdr:    { font: { bold: true, sz: 9, color: { rgb: BL } }, fill: { fgColor: { rgb: VD } },
              alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: borde(BL) },
    hdrM:   { font: { bold: true, sz: 9, color: { rgb: BL } }, fill: { fgColor: { rgb: '6D28D9' } },
              alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: borde(BL) },
  };
  function sDato(par, extra) {
    var s = { font: { sz: 9, color: { rgb: NG } }, fill: { fgColor: { rgb: par ? 'F6F8F6' : BL } },
              alignment: { horizontal: 'left', vertical: 'center' }, border: borde('E8EDE9') };
    if (extra) for (var k in extra) s[k] = extra[k];
    return s;
  }

  function txt(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function documento(f) { return txt(f.tipo_documento === 'RUC' ? (f.ruc || f.dni) : (f.dni || f.ruc)); }

  /** Edad en años cumplidos a partir de 'YYYY-MM-DD' (null si no hay fecha) */
  function edadAnios(fecha, hoy) {
    if (!fecha) return null;
    var p = String(fecha).slice(0, 10).split('-').map(Number);
    if (p.length !== 3 || !p[0]) return null;
    var e = hoy.getFullYear() - p[0];
    if (hoy.getMonth() + 1 < p[1] || (hoy.getMonth() + 1 === p[1] && hoy.getDate() < p[2])) e--;
    return e < 0 ? 0 : e;
  }

  function fechaHoy(hoy) {
    var d = function (n) { return (n < 10 ? '0' : '') + n; };
    return d(hoy.getDate()) + '/' + d(hoy.getMonth() + 1) + '/' + hoy.getFullYear();
  }

  /**
   * Arma una hoja: título (fila 1), info (fila 2), cabecera (fila 3) y datos desde la fila 4.
   * columnas: [{ t: 'Título', w: ancho, s: estiloCabecera?, num: true? }]
   * datos   : arreglo de arreglos con los valores
   */
  function hoja(XS, titulo, info, columnas, datos) {
    var n = columnas.length;
    var aoa = [[titulo], [info], columnas.map(function (c) { return c.t; })].concat(datos);
    var ws = XS.utils.aoa_to_sheet(aoa);

    var set = function (r, c, s) {
      var a = XS.utils.encode_cell({ r: r, c: c });
      if (!ws[a]) ws[a] = { t: 's', v: '' };
      ws[a].s = s;
    };
    for (var c = 0; c < n; c++) {
      set(0, c, ESTILOS.titulo);
      set(1, c, ESTILOS.info);
      set(2, c, columnas[c].s || ESTILOS.hdr);
    }
    datos.forEach(function (fila, i) {
      var par = i % 2 === 0;
      for (var c2 = 0; c2 < n; c2++) {
        var a = XS.utils.encode_cell({ r: i + 3, c: c2 });
        var v = fila[c2];
        if (v === null || v === undefined || v === '') {
          ws[a] = { t: 's', v: '' };
        } else if (columnas[c2].num) {
          ws[a] = { t: 'n', v: Number(v), z: columnas[c2].z || 'General' };
        } else {
          ws[a] = { t: 's', v: String(v) };   // texto: conserva ceros a la izquierda en DNI/teléfono
        }
        ws[a].s = sDato(par, columnas[c2].num ? { alignment: { horizontal: 'right', vertical: 'center' } } : null);
      }
    });

    var ultima = Math.max(3, datos.length + 3);
    ws['!ref']        = XS.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: ultima - 1, c: n - 1 } });
    ws['!merges']     = [{ s: { r: 0, c: 0 }, e: { r: 0, c: n - 1 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: n - 1 } }];
    ws['!cols']       = columnas.map(function (c) { return { wch: c.w || 14 }; });
    ws['!rows']       = [{ hpt: 24 }, { hpt: 16 }, { hpt: 28 }];
    ws['!autofilter'] = { ref: XS.utils.encode_range({ s: { r: 2, c: 0 }, e: { r: ultima - 1, c: n - 1 } }) };
    return ws;
  }

  function construirExcelPropietarios(XS, filas, opciones) {
    opciones = opciones || {};
    var hoy = opciones.hoy || new Date();
    var clinica = txt(opciones.clinica);
    var sufijo = (clinica ? clinica + ' — ' : '') + 'generado el ' + fechaHoy(hoy);

    // ── Agrupar por propietario ─────────────────────────────────
    var props = [], porId = {};
    filas.forEach(function (f) {
      var p = porId[f.propietario_id];
      if (!p) { p = porId[f.propietario_id] = { f: f, mascotas: [] }; props.push(p); }
      if (f.mascota_id) p.mascotas.push(f);
    });
    var totalMascotas = props.reduce(function (a, p) { return a + p.mascotas.length; }, 0);

    // ── Hoja 1: una fila por mascota ────────────────────────────
    var colsM = [
      { t: 'N°', w: 6, num: true },
      { t: 'Tipo doc.', w: 9 }, { t: 'N° documento', w: 13 },
      { t: 'Apellidos', w: 20 }, { t: 'Nombres', w: 20 }, { t: 'Razón social', w: 24 },
      { t: 'Teléfono', w: 13 }, { t: 'Email', w: 24 }, { t: 'Dirección', w: 30 },
      { t: 'Mascota', w: 16, s: ESTILOS.hdrM }, { t: 'Especie', w: 11, s: ESTILOS.hdrM },
      { t: 'Raza', w: 16, s: ESTILOS.hdrM }, { t: 'Sexo', w: 11, s: ESTILOS.hdrM },
      { t: 'F. nacimiento', w: 12, s: ESTILOS.hdrM }, { t: 'Edad (años)', w: 9, s: ESTILOS.hdrM, num: true },
      { t: 'Peso (kg)', w: 9, s: ESTILOS.hdrM, num: true, z: '0.00' }, { t: 'Color', w: 12, s: ESTILOS.hdrM },
      { t: 'Microchip', w: 15, s: ESTILOS.hdrM }, { t: 'Alergias', w: 22, s: ESTILOS.hdrM },
      { t: 'Alertas médicas', w: 26, s: ESTILOS.hdrM },
      { t: 'Cliente desde', w: 12 },
    ];
    var datosM = [], n = 0;
    props.forEach(function (p) {
      var f = p.f;
      var base = [txt(f.tipo_documento) || 'DNI', documento(f), txt(f.apellido), txt(f.nombre),
                  txt(f.razon_social), txt(f.telefono), txt(f.email), txt(f.direccion)];
      var lista = p.mascotas.length ? p.mascotas : [null];
      lista.forEach(function (m) {
        n++;
        datosM.push([n].concat(base, m ? [
          txt(m.mascota_nombre), ESPECIES[m.especie] || txt(m.especie), txt(m.raza),
          SEXOS[m.sexo] || txt(m.sexo), txt(m.fecha_nacimiento), edadAnios(m.fecha_nacimiento, hoy),
          m.peso_kg != null && m.peso_kg !== '' ? parseFloat(m.peso_kg) : null, txt(m.color),
          txt(m.microchip), txt(m.alergias), txt(m.alertas_medicas),
        ] : ['(sin mascotas)', '', '', '', '', null, null, '', '', '', ''], [txt(f.propietario_registro)]));
      });
    });

    // ── Hoja 2: una fila por propietario ────────────────────────
    var colsP = [
      { t: 'N°', w: 6, num: true },
      { t: 'Tipo doc.', w: 9 }, { t: 'N° documento', w: 13 },
      { t: 'Apellidos', w: 20 }, { t: 'Nombres', w: 20 }, { t: 'Razón social', w: 24 },
      { t: 'Teléfono', w: 13 }, { t: 'Email', w: 24 }, { t: 'Dirección', w: 30 },
      { t: 'N° mascotas', w: 10, num: true, s: ESTILOS.hdrM }, { t: 'Mascotas', w: 36, s: ESTILOS.hdrM },
      { t: 'Cliente desde', w: 12 },
    ];
    var datosP = props.map(function (p, i) {
      var f = p.f;
      return [i + 1, txt(f.tipo_documento) || 'DNI', documento(f), txt(f.apellido), txt(f.nombre),
              txt(f.razon_social), txt(f.telefono), txt(f.email), txt(f.direccion),
              p.mascotas.length,
              p.mascotas.map(function (m) {
                return txt(m.mascota_nombre) + ' (' + (ESPECIES[m.especie] || txt(m.especie)) + ')';
              }).join(', '),
              txt(f.propietario_registro)];
    });

    var wb = XS.utils.book_new();
    XS.utils.book_append_sheet(wb, hoja(XS, 'PROPIETARIOS Y MASCOTAS',
      props.length + ' propietarios · ' + totalMascotas + ' mascotas · ' + sufijo +
      ' · Usa las flechas de la fila de títulos para filtrar.', colsM, datosM), 'Propietarios y mascotas');
    XS.utils.book_append_sheet(wb, hoja(XS, 'PROPIETARIOS',
      props.length + ' propietarios · ' + sufijo, colsP, datosP), 'Propietarios');
    return { wb: wb, propietarios: props.length, mascotas: totalMascotas };
  }

  root.construirExcelPropietarios = construirExcelPropietarios;
  if (typeof module !== 'undefined' && module.exports) module.exports = { construirExcelPropietarios: construirExcelPropietarios };
})(typeof window !== 'undefined' ? window : globalThis);
