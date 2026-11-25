-- ============================================================
-- MIGRACIÓN v23 — Compras de inventario (facturas de proveedor), para clínicas YA CREADAS.
-- Las clínicas nuevas ya lo traen en tenant_schema.sql.
--
-- · compras: cabecera con los datos del comprobante del proveedor.
-- · compras_detalle: ítems de la compra, cada uno ligado a un producto del inventario.
--   Guarda el stock y costo que tenía el producto antes de la compra (trazabilidad
--   del costo promedio ponderado).
-- · inventario.lote: lote vigente del producto (va con su fecha de vencimiento).
-- · Se puede ejecutar varias veces.
-- · Ejecutarlo una vez por clínica: cambia el USE. ANTES de subir el código nuevo.
-- ============================================================

USE vet_mascotilandia;          -- ← clínica a migrar

-- ── Lote en el inventario ─────────────────────────────────────
SET @db := DATABASE();
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=@db AND TABLE_NAME='inventario' AND COLUMN_NAME='lote') = 0,
  'ALTER TABLE inventario ADD COLUMN lote VARCHAR(50) NULL DEFAULT NULL AFTER fecha_vencimiento',
  'SELECT ''inventario.lote ya existe'' AS info');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

CREATE TABLE IF NOT EXISTS compras (
  id                 INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  sede_id            INT UNSIGNED  NULL DEFAULT NULL,
  tipo_comprobante   ENUM('factura','boleta','nota_venta','guia','otro') NOT NULL DEFAULT 'factura',
  serie              VARCHAR(10)   NULL,
  numero             VARCHAR(20)   NOT NULL,
  fecha_emision      DATE          NOT NULL,
  proveedor_ruc      VARCHAR(11)   NULL,
  proveedor_nombre   VARCHAR(200)  NOT NULL,
  modo_igv           ENUM('sin_igv','con_igv','no_afecto') NOT NULL DEFAULT 'sin_igv'
                     COMMENT 'Cómo vienen los precios del comprobante',
  igv_porcentaje     DECIMAL(5,2)  NOT NULL DEFAULT 18.00,
  subtotal           DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'Valor de compra sin IGV',
  igv                DECIMAL(12,2) NOT NULL DEFAULT 0,
  total              DECIMAL(12,2) NOT NULL DEFAULT 0,
  observaciones      VARCHAR(255)  NULL,
  registrado_por_id  INT UNSIGNED  NOT NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_compras_fecha (fecha_emision),
  INDEX idx_compras_sede  (sede_id),
  INDEX idx_compras_doc   (proveedor_ruc, serie, numero),
  FOREIGN KEY (registrado_por_id) REFERENCES usuarios(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS compras_detalle (
  id                 INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  compra_id          INT UNSIGNED  NOT NULL,
  inventario_id      INT UNSIGNED  NOT NULL,
  descripcion        VARCHAR(200)  NOT NULL COMMENT 'Nombre del producto al momento de la compra',
  cantidad           DECIMAL(10,2) NOT NULL,
  precio_unitario    DECIMAL(12,4) NOT NULL COMMENT 'Precio unitario tal como figura en el comprobante',
  costo_unitario     DECIMAL(12,4) NOT NULL COMMENT 'Costo unitario que entra al inventario (con IGV)',
  subtotal           DECIMAL(12,2) NOT NULL COMMENT 'cantidad × precio_unitario',
  lote               VARCHAR(50)   NULL,
  fecha_vencimiento  DATE          NULL,
  stock_anterior     DECIMAL(10,2) NOT NULL DEFAULT 0,
  costo_anterior     DECIMAL(10,2) NOT NULL DEFAULT 0,
  costo_promedio     DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT 'Nuevo precio_compra del producto',
  INDEX idx_cd_inventario (inventario_id),
  FOREIGN KEY (compra_id) REFERENCES compras(id) ON DELETE CASCADE
) ENGINE=InnoDB;
