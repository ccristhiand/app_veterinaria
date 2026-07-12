-- ============================================================
-- VETCLINIC SaaS — SCHEMA BASE POR TENANT v2
-- Se ejecuta automáticamente al crear una nueva clínica
-- Compatible con MySQL 5.6+
-- ============================================================

-- Usuarios del sistema
CREATE TABLE usuarios (
  id         INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  nombre     VARCHAR(100)  NOT NULL,
  email      VARCHAR(150)  NOT NULL UNIQUE,
  password   VARCHAR(255)  NOT NULL,
  rol        ENUM('admin','veterinario','recepcionista') NOT NULL DEFAULT 'recepcionista',
  activo     TINYINT(1)    NOT NULL DEFAULT 1,
  created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Propietarios
CREATE TABLE propietarios (
  id               INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  nombre           VARCHAR(100)  NOT NULL,
  apellido         VARCHAR(100)  NOT NULL,
  dni              VARCHAR(20)   NULL,
  telefono         VARCHAR(30)   NULL,
  email            VARCHAR(150)  NULL,
  direccion        VARCHAR(255)  NULL,
  ruc              VARCHAR(20)   NULL,
  razon_social     VARCHAR(200)  NULL,
  direccion_fiscal VARCHAR(255)  NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Mascotas
CREATE TABLE mascotas (
  id               INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  propietario_id   INT UNSIGNED  NOT NULL,
  nombre           VARCHAR(100)  NOT NULL,
  especie          VARCHAR(50)   NOT NULL,
  raza             VARCHAR(100)  NULL,
  sexo             ENUM('macho','hembra','desconocido') NOT NULL DEFAULT 'desconocido',
  fecha_nacimiento DATE          NULL,
  peso_kg          DECIMAL(6,2)  NULL,
  color            VARCHAR(100)  NULL,
  microchip        VARCHAR(100)  NULL,
  alergias         TEXT          NULL,
  alertas_medicas  TEXT          NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (propietario_id) REFERENCES propietarios(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- Citas
CREATE TABLE citas (
  id              INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  mascota_id      INT UNSIGNED  NOT NULL,
  veterinario_id  INT UNSIGNED  NOT NULL,
  creada_por_id   INT UNSIGNED  NOT NULL,
  fecha_hora      DATETIME      NOT NULL,
  duracion_min    SMALLINT      NOT NULL DEFAULT 30,
  motivo          VARCHAR(255)  NOT NULL,
  notas           TEXT          NULL,
  estado          ENUM('pendiente','confirmada','en_curso','completada','cancelada') NOT NULL DEFAULT 'pendiente',
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mascota_id)     REFERENCES mascotas(id)  ON DELETE RESTRICT,
  FOREIGN KEY (veterinario_id) REFERENCES usuarios(id)  ON DELETE RESTRICT,
  FOREIGN KEY (creada_por_id)  REFERENCES usuarios(id)  ON DELETE RESTRICT,
  INDEX idx_fecha  (fecha_hora),
  INDEX idx_estado (estado),
  INDEX idx_vet    (veterinario_id)
) ENGINE=InnoDB;

-- Historia clínica
CREATE TABLE historia_clinica (
  id             INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  mascota_id     INT UNSIGNED  NOT NULL,
  veterinario_id INT UNSIGNED  NOT NULL,
  cita_id        INT UNSIGNED  NULL,
  fecha          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  motivo         VARCHAR(255)  NOT NULL,
  anamnesis      TEXT          NULL,
  exploracion    TEXT          NULL,
  diagnostico    TEXT          NULL,
  tratamiento    TEXT          NULL,
  observaciones  TEXT          NULL,
  peso_kg        DECIMAL(6,2)  NULL,
  temperatura_c  DECIMAL(4,1)  NULL,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mascota_id)     REFERENCES mascotas(id) ON DELETE RESTRICT,
  FOREIGN KEY (veterinario_id) REFERENCES usuarios(id) ON DELETE RESTRICT,
  FOREIGN KEY (cita_id)        REFERENCES citas(id)    ON DELETE SET NULL,
  INDEX idx_mascota (mascota_id)
) ENGINE=InnoDB;

-- Recetas
CREATE TABLE recetas (
  id                   INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  historia_clinica_id  INT UNSIGNED  NOT NULL,
  medicamento          VARCHAR(200)  NOT NULL,
  dosis                VARCHAR(100)  NOT NULL,
  frecuencia           VARCHAR(100)  NOT NULL,
  duracion_dias        TINYINT       NULL,
  instrucciones        TEXT          NULL,
  FOREIGN KEY (historia_clinica_id) REFERENCES historia_clinica(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Vacunas
CREATE TABLE vacunas (
  id               INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  mascota_id       INT UNSIGNED  NOT NULL,
  veterinario_id   INT UNSIGNED  NOT NULL,
  nombre           VARCHAR(150)  NOT NULL,
  fabricante       VARCHAR(100)  NULL,
  lote             VARCHAR(100)  NULL,
  fecha_aplicacion DATE          NOT NULL,
  proxima_dosis    DATE          NULL,
  notas            TEXT          NULL,
  notificado       TINYINT(1)    NOT NULL DEFAULT 0,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mascota_id)     REFERENCES mascotas(id) ON DELETE RESTRICT,
  FOREIGN KEY (veterinario_id) REFERENCES usuarios(id) ON DELETE RESTRICT,
  INDEX idx_mascota (mascota_id),
  INDEX idx_proxima (proxima_dosis)
) ENGINE=InnoDB;

-- Inventario
CREATE TABLE inventario (
  id              INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  nombre          VARCHAR(200)  NOT NULL,
  categoria       ENUM('medicamento','vacuna','insumo','otro') NOT NULL DEFAULT 'medicamento',
  descripcion     TEXT          NULL,
  cantidad        DECIMAL(10,2) NOT NULL DEFAULT 0,
  unidad          VARCHAR(30)   NOT NULL DEFAULT 'unidad',
  precio_unitario DECIMAL(10,2) NULL,
  proveedor       VARCHAR(150)  NULL,
  stock_minimo    DECIMAL(10,2) NOT NULL DEFAULT 5,
  fecha_vencimiento DATE        NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Estética / Baños
CREATE TABLE servicios_estetica (
  id              INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  mascota_id      INT UNSIGNED  NOT NULL,
  atendido_por_id INT UNSIGNED  NOT NULL,
  cita_id         INT UNSIGNED  NULL,
  fecha           DATE          NOT NULL,
  tipo_bano       ENUM('basico','completo','medicado','deslanado') NOT NULL DEFAULT 'basico',
  incluye_corte   TINYINT(1)    NOT NULL DEFAULT 0,
  incluye_unas    TINYINT(1)    NOT NULL DEFAULT 0,
  incluye_dental  TINYINT(1)    NOT NULL DEFAULT 0,
  productos       VARCHAR(255)  NULL,
  precio          DECIMAL(8,2)  NULL,
  observaciones   TEXT          NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mascota_id)      REFERENCES mascotas(id)  ON DELETE RESTRICT,
  FOREIGN KEY (atendido_por_id) REFERENCES usuarios(id)  ON DELETE RESTRICT,
  FOREIGN KEY (cita_id)         REFERENCES citas(id)     ON DELETE SET NULL
) ENGINE=InnoDB;

-- Notificaciones
CREATE TABLE notificaciones (
  id         INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  usuario_id INT UNSIGNED  NULL,
  tipo       VARCHAR(50)   NOT NULL,
  titulo     VARCHAR(200)  NOT NULL,
  mensaje    TEXT          NULL,
  leida      TINYINT(1)    NOT NULL DEFAULT 0,
  created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_usuario (usuario_id),
  INDEX idx_leida   (leida)
) ENGINE=InnoDB;

-- Catálogo de servicios
CREATE TABLE servicios_catalogo (
  id          INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(150)  NOT NULL,
  categoria   ENUM('consulta','vacunacion','estetica','cirugia','laboratorio','medicamento','otro') NOT NULL DEFAULT 'consulta',
  precio      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  descripcion VARCHAR(255)  NULL,
  activo      TINYINT(1)    NOT NULL DEFAULT 1,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Configuración empresa (para facturas)
CREATE TABLE empresa_config (
  id               INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  nombre           VARCHAR(150)  NOT NULL DEFAULT 'VetClinic',
  razon_social     VARCHAR(200)  NULL,
  ruc              VARCHAR(20)   NULL,
  direccion        VARCHAR(255)  NULL,
  distrito         VARCHAR(100)  NULL,
  ciudad           VARCHAR(100)  NULL DEFAULT 'Lima',
  telefono         VARCHAR(30)   NULL,
  email            VARCHAR(100)  NULL,
  web              VARCHAR(100)  NULL,
  logo_url         VARCHAR(500)  NULL,
  moneda           VARCHAR(10)   NOT NULL DEFAULT 'PEN',
  igv_porcentaje   DECIMAL(5,2)  NOT NULL DEFAULT 18.00,
  serie_boleta     VARCHAR(10)   NOT NULL DEFAULT 'B001',
  serie_factura    VARCHAR(10)   NOT NULL DEFAULT 'F001',
  correlativo_b    INT UNSIGNED  NOT NULL DEFAULT 1,
  correlativo_f    INT UNSIGNED  NOT NULL DEFAULT 1,
  pie_documento    TEXT          NULL,
  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Facturas
CREATE TABLE facturas (
  id                       INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  numero                   VARCHAR(20)   NOT NULL UNIQUE,
  tipo                     ENUM('boleta','factura') NOT NULL DEFAULT 'boleta',
  propietario_id           INT UNSIGNED  NOT NULL,
  mascota_id               INT UNSIGNED  NULL,
  cita_id                  INT UNSIGNED  NULL,
  emitido_por_id           INT UNSIGNED  NOT NULL,
  fecha                    DATE          NOT NULL,
  subtotal                 DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  igv                      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  total                    DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  estado                   ENUM('pendiente','pagado','anulado') NOT NULL DEFAULT 'pendiente',
  metodo_pago              ENUM('efectivo','tarjeta','transferencia','yape','plin') NULL,
  notas                    TEXT          NULL,
  cliente_ruc              VARCHAR(20)   NULL,
  cliente_razon_social     VARCHAR(200)  NULL,
  cliente_direccion_fiscal VARCHAR(255)  NULL,
  created_at               TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (propietario_id)  REFERENCES propietarios(id) ON DELETE RESTRICT,
  FOREIGN KEY (mascota_id)      REFERENCES mascotas(id)     ON DELETE SET NULL,
  FOREIGN KEY (cita_id)         REFERENCES citas(id)        ON DELETE SET NULL,
  FOREIGN KEY (emitido_por_id)  REFERENCES usuarios(id)     ON DELETE RESTRICT,
  INDEX idx_fecha  (fecha),
  INDEX idx_estado (estado)
) ENGINE=InnoDB;

-- Items de factura
CREATE TABLE factura_items (
  id          INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  factura_id  INT UNSIGNED  NOT NULL,
  descripcion VARCHAR(255)  NOT NULL,
  cantidad    DECIMAL(8,2)  NOT NULL DEFAULT 1.00,
  precio_unit DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  subtotal    DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  FOREIGN KEY (factura_id) REFERENCES facturas(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Pagos mixtos por factura
CREATE TABLE factura_pagos (
  id          INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  factura_id  INT UNSIGNED  NOT NULL,
  metodo_pago ENUM('efectivo','tarjeta','transferencia','yape','plin') NOT NULL,
  monto       DECIMAL(10,2) NOT NULL,
  referencia  VARCHAR(100)  NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (factura_id) REFERENCES facturas(id) ON DELETE CASCADE,
  INDEX idx_factura (factura_id)
) ENGINE=InnoDB;

-- ============================================================
-- VETCLINIC — MÓDULO CIERRE DE CAJA
-- mysql -u root -p vet_system < caja.sql
-- ============================================================

-- Cierres de caja
CREATE TABLE cierres_caja (
  id                    INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  fecha                 DATE          NOT NULL,
  turno                 ENUM('mañana','tarde','completo') NOT NULL DEFAULT 'completo',
  usuario_id            INT UNSIGNED  NOT NULL,

  -- Monto inicial
  monto_inicial         DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  -- Ingresos según sistema (calculados automáticamente)
  ingresos_efectivo     DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  ingresos_yape         DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  ingresos_plin         DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  ingresos_tarjeta      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  ingresos_transferencia DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  ingresos_total        DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  -- Gastos en efectivo
  gastos_total          DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  -- Conteo físico del operador
  efectivo_contado      DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  -- Cálculos
  efectivo_esperado     DECIMAL(10,2) NOT NULL DEFAULT 0.00,  -- inicial + ingresos_efectivo - gastos
  diferencia            DECIMAL(10,2) NOT NULL DEFAULT 0.00,  -- contado - esperado
  estado_diferencia     ENUM('exacto','sobrante','faltante') NOT NULL DEFAULT 'exacto',

  -- Estado
  estado                ENUM('borrador','cerrado') NOT NULL DEFAULT 'borrador',
  observaciones         TEXT          NULL,
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE RESTRICT,
  INDEX idx_fecha  (fecha),
  INDEX idx_estado (estado)
) ENGINE=InnoDB;

-- Gastos de caja
CREATE TABLE caja_gastos (
  id            INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  cierre_id     INT UNSIGNED  NULL,        -- NULL si es gasto del día sin cierre aún
  fecha         DATE          NOT NULL,
  concepto      VARCHAR(200)  NOT NULL,
  monto         DECIMAL(10,2) NOT NULL,
  categoria     ENUM('compra','servicio','mantenimiento','otro') NOT NULL DEFAULT 'otro',
  usuario_id    INT UNSIGNED  NOT NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (cierre_id)  REFERENCES cierres_caja(id) ON DELETE SET NULL,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id)     ON DELETE RESTRICT,
  INDEX idx_fecha (fecha)
) ENGINE=InnoDB;

SELECT 'Módulo cierre de caja instalado ✅' AS resultado;


-- ============================================================
-- VETCLINIC — Módulos Extra v2: Carnet Digital + Consentimientos
-- Sin módulo de recordatorios (desactivado temporalmente)
-- Ejecutar en cada DB de tenant
-- ============================================================

-- Carnets digitales (tokens públicos por mascota)
CREATE TABLE IF NOT EXISTS carnets_digitales (
  id          INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  mascota_id  INT UNSIGNED  NOT NULL UNIQUE,
  token       VARCHAR(64)   NOT NULL UNIQUE,
  activo      TINYINT(1)    NOT NULL DEFAULT 1,
  vistas      INT UNSIGNED  NOT NULL DEFAULT 0,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_token   (token),
  INDEX idx_mascota (mascota_id),
  FOREIGN KEY (mascota_id) REFERENCES mascotas(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Plantillas de consentimiento informado
CREATE TABLE IF NOT EXISTS consentimientos_plantillas (
  id          INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(150)  NOT NULL,
  tipo        ENUM('cirugia','anestesia','procedimiento','estetica','vacunacion','otro') NOT NULL DEFAULT 'procedimiento',
  contenido   LONGTEXT      NOT NULL,
  activo      TINYINT(1)    NOT NULL DEFAULT 1,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Consentimientos generados
CREATE TABLE IF NOT EXISTS consentimientos_generados (
  id              INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  plantilla_id    INT UNSIGNED  NOT NULL,
  mascota_id      INT UNSIGNED  NOT NULL,
  propietario_id  INT UNSIGNED  NOT NULL,
  veterinario_id  INT UNSIGNED  NOT NULL,
  contenido_final LONGTEXT      NOT NULL,
  firmado         TINYINT(1)    NOT NULL DEFAULT 0,
  firmado_at      TIMESTAMP     NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (plantilla_id)   REFERENCES consentimientos_plantillas(id) ON DELETE RESTRICT,
  FOREIGN KEY (mascota_id)     REFERENCES mascotas(id)                   ON DELETE RESTRICT,
  FOREIGN KEY (propietario_id) REFERENCES propietarios(id)               ON DELETE RESTRICT,
  FOREIGN KEY (veterinario_id) REFERENCES usuarios(id)                   ON DELETE RESTRICT,
  INDEX idx_mascota (mascota_id)
) ENGINE=InnoDB;

-- Plantillas por defecto
INSERT INTO consentimientos_plantillas (nombre, tipo, contenido) VALUES
('Consentimiento de Cirugía General', 'cirugia',
'<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:2rem">
  <div style="text-align:center;border-bottom:2px solid #166534;padding-bottom:1rem;margin-bottom:1.5rem">
    <h1 style="color:#166534;font-size:1.3rem;margin:0">CONSENTIMIENTO INFORMADO PARA CIRUGÍA</h1>
    <p style="color:#666;margin:.3rem 0 0">{{nombre_clinica}}</p>
  </div>
  <p>Yo, <strong>{{nombre_propietario}}</strong>, identificado(a) con DNI <strong>{{dni_propietario}}</strong>, en calidad de propietario(a) de la mascota <strong>{{nombre_mascota}}</strong> ({{especie}}, {{raza}}), declaro:</p>
  <ol style="line-height:2;margin:1rem 0">
    <li>He sido informado(a) sobre el procedimiento quirúrgico a realizarse.</li>
    <li>Comprendo que todo procedimiento quirúrgico conlleva riesgos inherentes incluyendo reacciones a la anestesia y complicaciones post-operatorias.</li>
    <li>Autorizo al equipo veterinario de <strong>{{nombre_clinica}}</strong> a realizar el procedimiento necesario.</li>
    <li>Me comprometo a seguir las indicaciones post-operatorias indicadas por el veterinario.</li>
  </ol>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:2rem;margin-top:3rem">
    <div style="text-align:center">
      <div style="border-top:1px solid #333;padding-top:.5rem">
        <p style="margin:0;font-size:.85rem"><strong>{{nombre_propietario}}</strong></p>
        <p style="margin:0;font-size:.75rem;color:#666">Propietario(a)</p>
      </div>
    </div>
    <div style="text-align:center">
      <div style="border-top:1px solid #333;padding-top:.5rem">
        <p style="margin:0;font-size:.85rem"><strong>{{nombre_veterinario}}</strong></p>
        <p style="margin:0;font-size:.75rem;color:#666">Médico Veterinario</p>
      </div>
    </div>
  </div>
  <p style="text-align:center;color:#999;font-size:.75rem;margin-top:2rem">Fecha: {{fecha}} · {{nombre_clinica}}</p>
</div>'),

('Consentimiento de Anestesia', 'anestesia',
'<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:2rem">
  <div style="text-align:center;border-bottom:2px solid #166534;padding-bottom:1rem;margin-bottom:1.5rem">
    <h1 style="color:#166534;font-size:1.3rem;margin:0">CONSENTIMIENTO PARA ANESTESIA GENERAL</h1>
    <p style="color:#666;margin:.3rem 0 0">{{nombre_clinica}}</p>
  </div>
  <p>Yo, <strong>{{nombre_propietario}}</strong>, DNI <strong>{{dni_propietario}}</strong>, autorizo la aplicación de anestesia general a mi mascota <strong>{{nombre_mascota}}</strong> ({{especie}}, {{raza}}, {{peso_kg}} kg).</p>
  <div style="background:#fff8e1;border-left:4px solid #f59e0b;padding:1rem;margin:1rem 0;border-radius:4px">
    <p style="margin:0;font-weight:bold">⚠️ Riesgos informados:</p>
    <ul style="margin:.5rem 0 0;line-height:1.8">
      <li>Reacciones alérgicas a los agentes anestésicos</li>
      <li>Depresión cardiorrespiratoria</li>
      <li>Hipotermia durante el procedimiento</li>
      <li>Recuperación prolongada</li>
    </ul>
  </div>
  <p>Confirmo que mi mascota ha cumplido con el ayuno previo indicado y que he informado al veterinario sobre cualquier condición médica preexistente.</p>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:2rem;margin-top:3rem">
    <div style="text-align:center">
      <div style="border-top:1px solid #333;padding-top:.5rem">
        <p style="margin:0;font-size:.85rem"><strong>{{nombre_propietario}}</strong></p>
        <p style="margin:0;font-size:.75rem;color:#666">Propietario(a) · DNI: {{dni_propietario}}</p>
      </div>
    </div>
    <div style="text-align:center">
      <div style="border-top:1px solid #333;padding-top:.5rem">
        <p style="margin:0;font-size:.85rem"><strong>{{nombre_veterinario}}</strong></p>
        <p style="margin:0;font-size:.75rem;color:#666">Médico Veterinario</p>
      </div>
    </div>
  </div>
  <p style="text-align:center;color:#999;font-size:.75rem;margin-top:2rem">Fecha: {{fecha}} · {{nombre_clinica}}</p>
</div>'),

('Consentimiento de Estética / Baño', 'estetica',
'<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:2rem">
  <div style="text-align:center;border-bottom:2px solid #166534;padding-bottom:1rem;margin-bottom:1.5rem">
    <h1 style="color:#166534;font-size:1.3rem;margin:0">AUTORIZACIÓN DE SERVICIOS DE ESTÉTICA</h1>
    <p style="color:#666;margin:.3rem 0 0">{{nombre_clinica}}</p>
  </div>
  <p>Yo, <strong>{{nombre_propietario}}</strong>, autorizo a {{nombre_clinica}} a realizar los servicios de estética y/o baño a mi mascota <strong>{{nombre_mascota}}</strong> ({{especie}}, {{raza}}).</p>
  <p style="margin-top:.75rem">Declaro que mi mascota se encuentra en buen estado de salud y no presenta enfermedades contagiosas, heridas abiertas o condiciones que impidan la realización del servicio.</p>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:2rem;margin-top:3rem">
    <div style="text-align:center">
      <div style="border-top:1px solid #333;padding-top:.5rem">
        <p style="margin:0;font-size:.85rem"><strong>{{nombre_propietario}}</strong></p>
        <p style="margin:0;font-size:.75rem;color:#666">Propietario(a)</p>
      </div>
    </div>
    <div style="text-align:center">
      <div style="border-top:1px solid #333;padding-top:.5rem">
        <p style="margin:0;font-size:.85rem"><strong>Recepcionista</strong></p>
        <p style="margin:0;font-size:.75rem;color:#666">{{nombre_clinica}}</p>
      </div>
    </div>
  </div>
  <p style="text-align:center;color:#999;font-size:.75rem;margin-top:2rem">Fecha: {{fecha}} · {{nombre_clinica}}</p>
</div>');

SELECT 'Carnet digital + Consentimientos instalados ✅' AS resultado;



-- Servicios de ejemplo iniciales
INSERT INTO servicios_catalogo (nombre, categoria, precio) VALUES
  ('Consulta general',       'consulta',   60.00),
  ('Consulta de urgencia',   'consulta',  100.00),
  ('Vacuna séxtuple canina', 'vacunacion', 45.00),
  ('Vacuna antirrábica',     'vacunacion', 35.00),
  ('Vacuna triple felina',   'vacunacion', 40.00),
  ('Baño básico',            'estetica',   35.00),
  ('Baño completo + corte',  'estetica',   60.00),
  ('Desparasitación interna','otro',        30.00),
  ('Examen de sangre',       'laboratorio',80.00);