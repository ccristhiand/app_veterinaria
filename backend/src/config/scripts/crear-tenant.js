#!/usr/bin/env node
'use strict';

/**
 * VetClinic SaaS — Script de creación de tenant
 * Uso: node crear-tenant.js
 *
 * O con argumentos:
 * node crear-tenant.js \
 *   --slug=aurora \
 *   --nombre="Clínica Aurora" \
 *   --subdominio=aurora.vetclinic.com \
 *   --admin-email=admin@aurora.com \
 *   --admin-pass=Admin1234!
 */

require('dotenv').config({ path: '../.env' });

const mysql  = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const path   = require('path');
const fs     = require('fs');
const readline = require('readline');

// Parsear argumentos CLI
const args = {};
process.argv.slice(2).forEach(arg => {
  const [key, val] = arg.replace('--','').split('=');
  args[key] = val;
});

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function main() {
  console.log('\n🐾 VetClinic SaaS — Crear nueva clínica\n');

  // Recopilar datos
  const slug       = args['slug']         || await prompt('Slug (ej: aurora): ');
  const nombre     = args['nombre']        || await prompt('Nombre de la clínica: ');
  const subdominio = args['subdominio']    || await prompt(`Subdominio (ej: ${slug}.vetclinic.com): `);
  const adminEmail = args['admin-email']   || await prompt('Email del administrador: ');
  const adminPass  = args['admin-pass']    || await prompt('Password del administrador: ');
  const adminNombre= args['admin-nombre']  || await prompt('Nombre del administrador [Administrador]: ') || 'Administrador';

  const dbName = `vet_${slug.replace(/-/g, '_')}`;

  console.log(`\n📋 Resumen:\n  Slug: ${slug}\n  DB: ${dbName}\n  Subdominio: ${subdominio}\n`);

  try {
    // 1. Conectar a master
    console.log('1️⃣  Conectando a base de datos maestra…');
    const masterConn = await mysql.createConnection({
      host    : process.env.MASTER_DB_HOST || process.env.DB_HOST || 'localhost',
      user    : process.env.MASTER_DB_USER || process.env.DB_USER || 'root',
      password: process.env.MASTER_DB_PASS || process.env.DB_PASS || '',
      database: 'vet_master',
    });

    // 2. Verificar duplicado
    const [[existente]] = await masterConn.execute(
      'SELECT id FROM tenants WHERE slug=? OR subdominio=?', [slug, subdominio]
    );
    if (existente) {
      console.error('❌ Error: ese slug o subdominio ya existe.');
      process.exit(1);
    }

    // 3. Crear DB del tenant
    console.log(`2️⃣  Creando base de datos ${dbName}…`);
    const rootConn = await mysql.createConnection({
      host    : process.env.DB_HOST || 'localhost',
      user    : process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
    });
    await rootConn.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await rootConn.end();

    // 4. Ejecutar schema
    console.log('3️⃣  Aplicando schema base…');
    const schemaPath = path.join(__dirname, '../sql/tenant_schema.sql');
    if (!fs.existsSync(schemaPath)) {
      console.error(`❌ No se encontró el schema en: ${schemaPath}`);
      process.exit(1);
    }
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const tenantConn = await mysql.createConnection({
      host    : process.env.DB_HOST || 'localhost',
      user    : process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: dbName,
      multipleStatements: true,
    });
    await tenantConn.query(schema);

    // 5. Crear admin inicial
    console.log('4️⃣  Creando usuario administrador…');
    const hashed = await bcrypt.hash(adminPass, 10);
    await tenantConn.execute(
      "INSERT INTO usuarios (nombre, email, password, rol) VALUES (?,?,?,'admin')",
      [adminNombre, adminEmail, hashed]
    );

    // 6. Config empresa inicial
    await tenantConn.execute(
      "INSERT INTO empresa_config (nombre) VALUES (?)", [nombre]
    );

    // 7. Servicios de ejemplo
    await tenantConn.execute(`
      INSERT INTO servicios_catalogo (nombre, categoria, precio) VALUES
      ('Consulta general','consulta',60.00),
      ('Vacuna séxtuple','vacunacion',45.00),
      ('Baño básico','estetica',35.00),
      ('Desparasitación','otro',30.00)
    `);

    await tenantConn.end();

    // 8. Registrar en master
    console.log('5️⃣  Registrando en base de datos maestra…');
    const [result] = await masterConn.execute(
      `INSERT INTO tenants (slug, subdominio, db_name, db_host, db_user, db_pass)
       VALUES (?,?,?,?,?,?)`,
      [slug, subdominio, dbName,
       process.env.DB_HOST||'localhost',
       process.env.DB_USER||'root',
       process.env.DB_PASS||'']
    );
    const tenantId = result.insertId;

    await masterConn.execute(
      `INSERT INTO tenant_config (tenant_id, nombre_clinica) VALUES (?,?)`,
      [tenantId, nombre]
    );
    await masterConn.end();

    console.log(`\n✅ ¡Clínica "${nombre}" creada exitosamente!\n`);
    console.log(`   🌐 URL:      https://${subdominio}`);
    console.log(`   🗄️  Base de datos: ${dbName}`);
    console.log(`   👤 Admin:    ${adminEmail}`);
    console.log(`   🔑 Password: ${adminPass}\n`);

  } catch (err) {
    console.error(`\n❌ Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();