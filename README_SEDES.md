# Multi-Sedes — Instrucciones de deploy

## Orden de ejecución

### 1. Base de datos (ejecutar en CADA tenant: vet_cris, vet_patitas, etc.)

```bash
mysql -u root -p vet_cris < migracion_sedes.sql
mysql -u root -p vet_patitas < migracion_sedes.sql
# repetir para cada tenant activo
```

### 2. Backend — archivos a reemplazar

Copiar los archivos generados a tu proyecto:

```
sedes.routes.js      → backend/src/routes/sedes.routes.js       (ARCHIVO NUEVO)
auth.routes.js       → backend/src/routes/auth.routes.js        (REEMPLAZAR)
usuarios.routes.js   → backend/src/routes/usuarios.routes.js    (REEMPLAZAR)
```

### 3. backend/src/index.js — agregar 2 líneas

Busca la línea donde están los otros requires de rutas:
```js
const desparasitacionesRoutes = require('./routes/desparasitaciones.routes');
```
Y DEBAJO agrega:
```js
const sedesRoutes = require('./routes/sedes.routes');
```

Busca donde se montan las rutas:
```js
app.use(`${API}/desparasitaciones`, desparasitacionesRoutes);
```
Y DEBAJO agrega:
```js
app.use(`${API}/sedes`, sedesRoutes);
```

### 4. Frontend — archivos a reemplazar

```
shared.js  → frontend/js/shared.js    (REEMPLAZAR)
layout.js  → frontend/js/layout.js    (REEMPLAZAR)
```

### 5. Crear sedes.html

Pendiente: crear el panel de gestión de sedes (CRUD visual).

---

## Qué cambia funcionalmente

- Al hacer **login**, la respuesta incluye `sede_id`, `sede_nombre`, `sede_ciudad`
  que se guardan en `localStorage('vet_user')`.
- Cada request a la API lleva el header `X-Sede-Id` automáticamente.
- El **sidebar** muestra el nombre de la sede debajo del nombre de la clínica.
- El menú **Sedes** aparece solo para usuarios con rol `admin`.
- Al **crear/editar** un usuario, el formulario debe incluir un `<select>` con las sedes
  cargadas desde `GET /api/v1/sedes?activo=true`.

## Próximo paso — sedes.html

El panel de gestión necesita:
- Tabla con listado de sedes (nombre, ciudad, activo, principal)
- Modal crear/editar sede (nombre, dirección, teléfono, email, ciudad)
- Botón toggle activo/inactivo
- Botón eliminar (bloqueado si tiene usuarios)