-- ============================================================
-- MIGRACIÓN v20 — Descripción larga en servicios, para clínicas YA CREADAS
-- Las clínicas nuevas ya lo traen en tenant_schema.sql.
--
-- · servicios_catalogo.descripcion pasa de VARCHAR(255) a TEXT (no se pierden datos).
-- · Se puede ejecutar varias veces.
-- · Ejecutarlo una vez por clínica: cambia el USE.
-- ============================================================

USE vet_mascotilandia;          -- ← clínica a migrar

ALTER TABLE servicios_catalogo
  MODIFY descripcion TEXT NULL;

-- Verificación: debe decir 'text'
SELECT COLUMN_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'servicios_catalogo' AND COLUMN_NAME = 'descripcion';
