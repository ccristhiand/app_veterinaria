-- ============================================================
-- MIGRACIÓN v21 — Módulo de Gastos diarios, para clínicas YA CREADAS
-- Las clínicas nuevas ya lo traen en tenant_schema.sql.
--
-- · Crea gastos_categorias (tipos de gasto, con datos iniciales) y gastos.
-- · Agrega a caja_cierres el desglose de gastos por método de pago.
-- · Copia los gastos antiguos de caja_gastos a la nueva tabla (como efectivo,
--   ligados a su cierre). caja_gastos NO se borra: queda como respaldo.
-- · Se puede ejecutar varias veces.
-- · Ejecutarlo una vez por clínica: cambia el USE.
-- ============================================================

USE vet_mascotilandia;          -- ← clínica a migrar

-- ── 1. Tipos de gasto ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gastos_categorias (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre     VARCHAR(60)  NOT NULL,
  icono      VARCHAR(16)  NULL,
  color      VARCHAR(7)   NULL,
  orden      SMALLINT     NOT NULL DEFAULT 0,
  activo     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_nombre (nombre)
) ENGINE=InnoDB;

INSERT IGNORE INTO gastos_categorias (nombre, icono, color, orden) VALUES
  ('Compras e insumos',         '💊', '#0f766e', 1),
  ('Pago a proveedores',        '📦', '#1d4ed8', 2),
  ('Servicios básicos',         '💡', '#b45309', 3),
  ('Alquiler',                  '🏠', '#7c3aed', 4),
  ('Sueldos y honorarios',      '👥', '#be185d', 5),
  ('Movilidad y delivery',      '🛵', '#0369a1', 6),
  ('Limpieza y mantenimiento',  '🧹', '#15803d', 7),
  ('Alimentación y refrigerio', '☕', '#a16207', 8),
  ('Publicidad y marketing',    '📣', '#c2410c', 9),
  ('Impuestos y trámites',      '🏛️', '#475569', 10),
  ('Otros',                     '📌', '#64748b', 99);

-- ── 2. Gastos ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gastos (
  id                INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  fecha             DATE          NOT NULL,
  sede_id           INT UNSIGNED  NULL DEFAULT NULL,
  categoria_id      INT UNSIGNED  NOT NULL,
  descripcion       VARCHAR(255)  NOT NULL,
  monto             DECIMAL(10,2) NOT NULL,
  metodo_pago       ENUM('efectivo','tarjeta','transferencia','yape','plin') NOT NULL DEFAULT 'efectivo',
  proveedor         VARCHAR(120)  NULL,
  comprobante       VARCHAR(60)   NULL COMMENT 'N° de boleta/factura/recibo del proveedor',
  registrado_por_id INT UNSIGNED  NOT NULL,
  cierre_id         INT UNSIGNED  NULL DEFAULT NULL COMMENT 'Cierre de caja que lo incluyó',
  anulado           TINYINT(1)    NOT NULL DEFAULT 0,
  anulado_por_id    INT UNSIGNED  NULL,
  anulado_motivo    VARCHAR(200)  NULL,
  anulado_at        DATETIME      NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (categoria_id)      REFERENCES gastos_categorias(id) ON DELETE RESTRICT,
  FOREIGN KEY (registrado_por_id) REFERENCES usuarios(id)          ON DELETE RESTRICT,
  FOREIGN KEY (cierre_id)         REFERENCES caja_cierres(id)      ON DELETE SET NULL,
  INDEX idx_fecha     (fecha),
  INDEX idx_sede      (sede_id),
  INDEX idx_categoria (categoria_id),
  INDEX idx_cierre    (cierre_id)
) ENGINE=InnoDB;

-- ── 3. Desglose de gastos por método en el cierre ─────────────
-- (ADD COLUMN IF NOT EXISTS requiere MariaDB; en MySQL se valida con information_schema)
SET @db := DATABASE();
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=@db AND TABLE_NAME='caja_cierres' AND COLUMN_NAME='gastos_efectivo') = 0,
  'ALTER TABLE caja_cierres
     ADD COLUMN gastos_efectivo      DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER total_gastos,
     ADD COLUMN gastos_tarjeta       DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER gastos_efectivo,
     ADD COLUMN gastos_transferencia DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER gastos_tarjeta,
     ADD COLUMN gastos_yape          DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER gastos_transferencia,
     ADD COLUMN gastos_plin          DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER gastos_yape',
  'SELECT ''columnas de gastos ya existen'' AS info');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- Los cierres antiguos solo tenían gastos en efectivo
UPDATE caja_cierres SET gastos_efectivo = total_gastos
WHERE gastos_efectivo = 0 AND total_gastos > 0;

-- ── 4. Copiar gastos antiguos (solo si la tabla nueva está vacía) ─
INSERT INTO gastos (fecha, sede_id, categoria_id, descripcion, monto, metodo_pago,
                    registrado_por_id, cierre_id, created_at)
SELECT cc.fecha, cc.sede_id,
       (SELECT gc.id FROM gastos_categorias gc WHERE gc.nombre =
          CASE cg.categoria
            WHEN 'compra'         THEN 'Compras e insumos'
            WHEN 'servicio'       THEN 'Servicios básicos'
            WHEN 'pago_proveedor' THEN 'Pago a proveedores'
            ELSE 'Otros' END),
       cg.descripcion, cg.monto, 'efectivo',
       cc.realizado_por_id, cc.id, cg.created_at
FROM caja_gastos cg
JOIN caja_cierres cc ON cc.id = cg.cierre_id
WHERE NOT EXISTS (SELECT 1 FROM (SELECT id FROM gastos LIMIT 1) AS ya);

-- Verificación
SELECT (SELECT COUNT(*) FROM gastos_categorias) AS categorias,
       (SELECT COUNT(*) FROM gastos)            AS gastos_migrados,
       (SELECT COUNT(*) FROM caja_gastos)       AS gastos_antiguos;
