-- ============================================================
-- MIGRACIÓN v19 — Rol "groomer" (estética), para clínicas YA CREADAS
-- Las clínicas nuevas ya lo traen en tenant_schema.sql.
--
-- · Solo agrega el valor 'groomer' al rol de usuarios (no cambia datos).
-- · Se puede ejecutar varias veces.
-- · Ejecutarlo una vez por clínica: cambia el USE.
-- ============================================================

USE vet_mascotilandia;          -- ← clínica a migrar

ALTER TABLE usuarios
  MODIFY rol ENUM('admin','veterinario','recepcionista','veterinario_recepcionista','groomer')
             NOT NULL DEFAULT 'recepcionista';

-- Verificación: debe incluir 'groomer'
SELECT COLUMN_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'rol';
