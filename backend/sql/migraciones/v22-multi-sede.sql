-- ============================================================
-- MIGRACIÓN v22 — Usuarios con varias sedes y limpieza de registros sin sede,
-- para clínicas YA CREADAS. Requiere v21 (tabla gastos).
-- Las clínicas nuevas ya lo traen en tenant_schema.sql.
--
-- · Crea usuario_sedes y copia ahí la sede actual de cada usuario.
-- · Agrega empresa_config.gastos_afectan_caja (activado por defecto).
-- · Los usuarios no-admin sin sede pasan a la sede principal.
-- · Los registros sin sede pasan a la sede de su cita/veterinario o a la principal.
-- · Se puede ejecutar varias veces.
-- · Ejecutarlo una vez por clínica: cambia el USE. ANTES de subir el código nuevo.
-- ============================================================

USE vet_mascotilandia;          -- ← clínica a migrar

-- ── 1. Sedes por usuario ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuario_sedes (
  usuario_id INT UNSIGNED NOT NULL,
  sede_id    INT UNSIGNED NOT NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (usuario_id, sede_id),
  INDEX idx_sede (sede_id),
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
  FOREIGN KEY (sede_id)    REFERENCES sedes(id)    ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── 2. Configuración: ¿los gastos afectan al cierre de caja? ──
SET @db := DATABASE();
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=@db AND TABLE_NAME='empresa_config' AND COLUMN_NAME='gastos_afectan_caja') = 0,
  'ALTER TABLE empresa_config ADD COLUMN gastos_afectan_caja TINYINT(1) NOT NULL DEFAULT 1',
  'SELECT ''gastos_afectan_caja ya existe'' AS info');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 3. Sede principal de la clínica ───────────────────────────
SET @principal := (SELECT id FROM sedes WHERE activo = 1 ORDER BY es_principal DESC, id ASC LIMIT 1);

-- ── 4. Usuarios ───────────────────────────────────────────────
UPDATE usuarios SET sede_id = @principal WHERE sede_id IS NULL AND rol <> 'admin';

INSERT IGNORE INTO usuario_sedes (usuario_id, sede_id)
SELECT u.id, u.sede_id FROM usuarios u JOIN sedes s ON s.id = u.sede_id;

-- ── 5. Conteo previo (para saber qué se va a mover) ───────────
SELECT 'antes' AS momento,
       (SELECT COUNT(*) FROM inventario         WHERE sede_id IS NULL) AS inventario,
       (SELECT COUNT(*) FROM citas              WHERE sede_id IS NULL) AS citas,
       (SELECT COUNT(*) FROM facturas           WHERE sede_id IS NULL) AS facturas,
       (SELECT COUNT(*) FROM proformas          WHERE sede_id IS NULL) AS proformas,
       (SELECT COUNT(*) FROM caja_cierres       WHERE sede_id IS NULL) AS cierres,
       (SELECT COUNT(*) FROM gastos             WHERE sede_id IS NULL) AS gastos,
       (SELECT COUNT(*) FROM servicios_estetica WHERE sede_id IS NULL) AS estetica;

-- ── 6. Registros sin sede ─────────────────────────────────────
UPDATE citas c JOIN usuarios u ON u.id = c.veterinario_id
SET c.sede_id = COALESCE(u.sede_id, @principal)
WHERE c.sede_id IS NULL;

UPDATE inventario SET sede_id = @principal WHERE sede_id IS NULL;

UPDATE facturas f LEFT JOIN citas c ON c.id = f.cita_id
SET f.sede_id = COALESCE(c.sede_id, @principal)
WHERE f.sede_id IS NULL;

UPDATE proformas    SET sede_id = @principal WHERE sede_id IS NULL;
UPDATE caja_cierres SET sede_id = @principal WHERE sede_id IS NULL;
UPDATE gastos       SET sede_id = @principal WHERE sede_id IS NULL;

UPDATE servicios_estetica e
LEFT JOIN citas c    ON c.id = e.cita_id
LEFT JOIN usuarios u ON u.id = e.atendido_por_id
SET e.sede_id = COALESCE(c.sede_id, u.sede_id, @principal)
WHERE e.sede_id IS NULL;

-- Verificación: todo en 0, y usuarios_con_sedes > 0
SELECT 'despues' AS momento,
       (SELECT COUNT(*) FROM inventario         WHERE sede_id IS NULL) AS inventario,
       (SELECT COUNT(*) FROM citas              WHERE sede_id IS NULL) AS citas,
       (SELECT COUNT(*) FROM facturas           WHERE sede_id IS NULL) AS facturas,
       (SELECT COUNT(*) FROM proformas          WHERE sede_id IS NULL) AS proformas,
       (SELECT COUNT(*) FROM caja_cierres       WHERE sede_id IS NULL) AS cierres,
       (SELECT COUNT(*) FROM gastos             WHERE sede_id IS NULL) AS gastos,
       (SELECT COUNT(*) FROM servicios_estetica WHERE sede_id IS NULL) AS estetica,
       (SELECT COUNT(DISTINCT usuario_id) FROM usuario_sedes)          AS usuarios_con_sedes;
