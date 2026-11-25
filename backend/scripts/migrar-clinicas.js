#!/usr/bin/env node
'use strict';

/**
 * Pase de migraciones a TODAS las clínicas.
 *
 * Lee las clínicas de vet_master (tabla tenants) y ejecuta los archivos de
 * sql/migraciones en la base de cada una. Las migraciones están hechas para poder
 * ejecutarse varias veces, así que repetir el pase no rompe nada.
 *
 * Uso (desde la carpeta backend, usa las credenciales de backend/.env):
 *
 *   node scripts/migrar-clinicas.js v23                 → SIMULACRO: muestra qué haría, no cambia nada
 *   node scripts/migrar-clinicas.js v23 --ejecutar      → aplica la migración en todas las clínicas
 *   node scripts/migrar-clinicas.js v22 v23 --ejecutar  → varias migraciones, en ese orden
 *   node scripts/migrar-clinicas.js v23 --ejecutar --solo mascotilandia,otraclinica
 *   node scripts/migrar-clinicas.js v23 --ejecutar --solo-activas
 *
 * La migración se indica por versión (v23) o por ruta al .sql.
 * La línea "USE ...;" del archivo se ignora: cada clínica se migra en su propia base.
 * Si una clínica falla, se sigue con las demás y al final se muestra el resumen
 * (código de salida 1 si alguna falló).
 */

const fs    = require('fs');
const path  = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const DIR_MIGRACIONES = path.join(__dirname, '..', 'sql', 'migraciones');

// ── Argumentos ────────────────────────────────────────────────────
function leerArgs(argv) {
  const args = { migraciones: [], ejecutar: false, solo: null, soloActivas: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ejecutar')          args.ejecutar = true;
    else if (a === '--solo-activas') args.soloActivas = true;
    else if (a === '--solo')         args.solo = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--solo=')) args.solo = a.slice(7).split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--'))     throw new Error(`Opción desconocida: ${a}`);
    else                             args.migraciones.push(a);
  }
  if (!args.migraciones.length) throw new Error('Indica la migración, por ejemplo: node scripts/migrar-clinicas.js v23');
  return args;
}

/** 'v23' → sql/migraciones/v23-....sql ; también acepta una ruta directa */
function resolverMigracion(ref) {
  if (fs.existsSync(ref) && fs.statSync(ref).isFile()) return path.resolve(ref);
  const archivos = fs.readdirSync(DIR_MIGRACIONES).filter(f => f.endsWith('.sql'));
  const hallados = archivos.filter(f => f === ref || f.startsWith(ref + '-') || f === ref + '.sql');
  if (hallados.length !== 1) {
    throw new Error(hallados.length
      ? `"${ref}" coincide con varios archivos: ${hallados.join(', ')}`
      : `No se encontró la migración "${ref}" en sql/migraciones (${archivos.join(', ')})`);
  }
  return path.join(DIR_MIGRACIONES, hallados[0]);
}

/**
 * Divide un script SQL en sentencias, como lo hace el cliente mysql:
 * respeta comillas, comentarios y los bloques DELIMITER (procedimientos).
 * Quita las sentencias USE (cada clínica se ejecuta en su propia base).
 */
function dividirSQL(sql) {
  const sentencias = [];
  let delim = ';', actual = '', i = 0, inicioLinea = true;
  const n = sql.length;

  const emitir = () => {
    const s = actual.trim();
    actual = '';
    if (!s) return;
    if (/^USE\s+/i.test(s)) return;
    sentencias.push(s);
  };

  while (i < n) {
    // DELIMITER al inicio de línea (fuera de comillas)
    if (inicioLinea) {
      const resto = sql.slice(i);
      const m = resto.match(/^[ \t]*DELIMITER[ \t]+(\S+)[^\n]*(\n|$)/i);
      if (m) { emitir(); delim = m[1]; i += m[0].length; inicioLinea = true; continue; }
    }
    const c = sql[i];

    // Comentarios
    if (c === '-' && sql[i + 1] === '-' && (i + 2 >= n || /\s/.test(sql[i + 2]))) {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '#') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') {
      const fin = sql.indexOf('*/', i + 2);
      i = fin === -1 ? n : fin + 2;
      continue;
    }

    // Cadenas y nombres entre comillas (con '' y \' escapados)
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\' && c !== '`') { j += 2; continue; }
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      actual += sql.slice(i, j + 1);
      i = j + 1;
      inicioLinea = false;
      continue;
    }

    // Fin de sentencia
    if (sql.startsWith(delim, i)) { emitir(); i += delim.length; inicioLinea = false; continue; }

    actual += c;
    inicioLinea = c === '\n';
    i++;
  }
  emitir();
  return sentencias;
}

const resumen = (s) => s.replace(/\s+/g, ' ').slice(0, 90) + (s.length > 90 ? '…' : '');

async function main() {
  const args = leerArgs(process.argv.slice(2));
  const migraciones = args.migraciones.map((ref) => {
    const archivo = resolverMigracion(ref);
    return { nombre: path.basename(archivo), sentencias: dividirSQL(fs.readFileSync(archivo, 'utf8')) };
  });

  console.log(`\n${args.ejecutar ? '🚀 EJECUCIÓN' : '🧪 SIMULACRO (no se cambia nada; agrega --ejecutar para aplicar)'}`);
  for (const m of migraciones) console.log(`   · ${m.nombre}: ${m.sentencias.length} sentencias`);

  // ── Clínicas ──────────────────────────────────────────────────
  const master = await mysql.createConnection({
    host    : process.env.MASTER_DB_HOST || 'localhost',
    port    : parseInt(process.env.MASTER_DB_PORT || '3306'),
    user    : process.env.MASTER_DB_USER || 'root',
    password: process.env.MASTER_DB_PASS || '',
    database: process.env.MASTER_DB_NAME || 'vet_master',
    connectTimeout: 15000,
  });
  let [tenants] = await master.query(
    'SELECT id, slug, db_name, db_host, db_port, db_user, db_pass, activo FROM tenants ORDER BY id'
  );
  await master.end();

  if (args.soloActivas) tenants = tenants.filter(t => t.activo);
  if (args.solo) {
    const faltan = args.solo.filter(s => !tenants.some(t => t.slug === s || t.db_name === s));
    if (faltan.length) throw new Error(`No existen estas clínicas: ${faltan.join(', ')}`);
    tenants = tenants.filter(t => args.solo.includes(t.slug) || args.solo.includes(t.db_name));
  }
  if (!tenants.length) { console.log('\nNo hay clínicas para migrar.'); return 0; }

  console.log(`\nClínicas (${tenants.length}):`);
  for (const t of tenants) console.log(`   · ${t.slug.padEnd(24)} ${t.db_name}${t.activo ? '' : '  (suspendida)'}`);

  if (!args.ejecutar) {
    console.log('\nSentencias que se ejecutarían en cada clínica:');
    for (const m of migraciones) {
      console.log(`\n  ── ${m.nombre}`);
      m.sentencias.forEach((s, i) => console.log(`   ${String(i + 1).padStart(3)}. ${resumen(s)}`));
    }
    console.log('\n✔ Simulacro terminado. Para aplicar: agrega --ejecutar\n');
    return 0;
  }

  // ── Ejecución ─────────────────────────────────────────────────
  const resultados = [];
  for (const t of tenants) {
    process.stdout.write(`\n▶ ${t.slug} (${t.db_name}) … `);
    let conn;
    try {
      conn = await mysql.createConnection({
        host    : t.db_host || process.env.DB_HOST || 'localhost',
        port    : t.db_port || parseInt(process.env.DB_PORT || '3306'),
        user    : t.db_user || process.env.DB_USER || 'root',
        password: t.db_pass || process.env.DB_PASS || '',
        database: t.db_name,
        connectTimeout: 15000,
      });
      for (const m of migraciones) {
        for (let i = 0; i < m.sentencias.length; i++) {
          try {
            await conn.query(m.sentencias[i]);
          } catch (e) {
            e.message = `${m.nombre}, sentencia ${i + 1} [${resumen(m.sentencias[i])}]: ${e.message}`;
            throw e;
          }
        }
      }
      console.log('✅ OK');
      resultados.push({ slug: t.slug, ok: true });
    } catch (e) {
      console.log(`❌ ERROR\n   ${e.message}`);
      resultados.push({ slug: t.slug, ok: false, error: e.message });
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  }

  const fallidas = resultados.filter(r => !r.ok);
  console.log(`\n════ Resumen: ${resultados.length - fallidas.length} OK, ${fallidas.length} con error`);
  for (const f of fallidas) console.log(`   ❌ ${f.slug}`);
  if (fallidas.length) console.log('\nCorrige el problema y vuelve a correr solo esas: --solo ' + fallidas.map(f => f.slug).join(','));
  console.log('');
  return fallidas.length ? 1 : 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch((e) => {
    console.error(`\n❌ ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { main, dividirSQL, leerArgs, resolverMigracion };
