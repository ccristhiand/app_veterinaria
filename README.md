# 🐾 VetClinic SaaS

Sistema integral de gestión veterinaria multitenant. Cada clínica opera con su propia base de datos, subdominio y configuración visual independiente.

---

## 🏗️ Stack tecnológico

| Capa | Tecnología |
|---|---|
| Backend | Node.js + Express |
| Base de datos | MySQL (una DB por tenant) |
| Autenticación | JWT + Refresh Token |
| Tiempo real | Socket.io |
| Frontend | HTML + CSS + JS vanilla + Tailwind CDN |
| Excel | xlsx-js-style + SheetJS |
| Deploy | PM2 + Nginx |

---

## 📁 Estructura del proyecto

```
vetclinic/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   ├── masterDB.js          ← conexión a vet_master
│   │   │   ├── tenantDB.js          ← pool por tenant con caché
│   │   │   └── logger.js
│   │   ├── middlewares/
│   │   │   ├── tenant.middleware.js ← resuelve tenant por subdominio
│   │   │   └── auth.middleware.js   ← JWT + roles
│   │   ├── routes/
│   │   │   ├── admin.routes.js      ← panel SaaS
│   │   │   ├── auth.routes.js
│   │   │   ├── branding.routes.js   ← colores/logo público
│   │   │   ├── citas.routes.js
│   │   │   ├── consentimientos.routes.js
│   │   │   ├── empresa.routes.js
│   │   │   ├── facturas.routes.js
│   │   │   ├── historia.routes.js
│   │   │   ├── inventario.routes.js
│   │   │   ├── mascotas.routes.js
│   │   │   ├── propietarios.routes.js
│   │   │   ├── reportes.routes.js
│   │   │   ├── servicios.routes.js
│   │   │   ├── usuarios.routes.js
│   │   │   └── vacunas.routes.js
│   │   ├── sockets/
│   │   │   └── index.js
│   │   └── index.js
│   ├── sql/
│   │   ├── tenant_schema.sql        ← schema base por clínica
│   │   └── master_schema.sql        ← schema vet_master
│   ├── .env.example
│   └── package.json
└── frontend/
    ├── js/
    │   ├── shared.js                ← API_URL, api(), socket, loader
    │   └── layout.js                ← sidebar, branding, planes
    ├── css/
    │   └── app.css
    ├── admin/
    │   └── index.html               ← panel SaaS
    ├── dashboard.html
    ├── citas.html
    ├── propietarios.html
    ├── mascotas.html
    ├── historia.html
    ├── inventario.html
    ├── facturacion.html
    ├── caja.html
    ├── servicios.html
    ├── reportes.html
    ├── usuarios.html
    ├── consentimientos.html
    ├── configuracion.html
    ├── carnet-publico.html
    └── login.html
```

---

## ⚙️ Instalación local (desarrollo)

### 1. Clonar el repositorio

```bash
git clone https://github.com/tu-usuario/vetclinic.git
cd vetclinic
```

### 2. Instalar dependencias del backend

```bash
cd backend
npm install
```

### 3. Configurar variables de entorno

```bash
cp .env.example .env
# Editar .env con tus datos
```

### 4. Crear la base de datos maestra

```bash
mysql -u root -p < sql/master_schema.sql
```

### 5. Configurar hosts locales (Windows)

Editar `C:\Windows\System32\drivers\etc\hosts`:

```
127.0.0.1  bet.test
127.0.0.1  patitas.test
127.0.0.1  petdog.test
```

### 6. Iniciar el backend

```bash
npm run dev
# Backend en http://localhost:4000
```

### 7. Iniciar el frontend

```bash
# Desde la carpeta frontend
npx serve -p 60442 -l tcp://0.0.0.0:60443
```

### 8. Acceder al panel admin SaaS

```
http://localhost:60442/admin/index.html
Usuario:  admin@vetclinic.com
Password: Admin1234!
```

### 9. Crear primera clínica desde el panel admin

Una vez creada, acceder en:
```
http://bet.test:60442/login.html
```

---

## 🌐 Despliegue en producción (VPS + Nginx)

### 1. Clonar en el VPS

```bash
ssh usuario@IP_VPS
git clone https://github.com/tu-usuario/vetclinic.git /var/www/vetclinic
cd /var/www/vetclinic/backend
```

### 2. Instalar dependencias

```bash
npm install --production
```

### 3. Configurar .env de producción

```bash
cp .env.example .env
nano .env
```

```env
NODE_ENV=production
PORT=4000
MASTER_DB_HOST=tu-servidor-mysql
MASTER_DB_PORT=3306
MASTER_DB_USER=usuario
MASTER_DB_PASS=password
MASTER_DB_NAME=vet_master
JWT_SECRET=secreto_muy_largo_aqui
JWT_REFRESH_SECRET=otro_secreto_aqui
JWT_EXPIRES_IN=8h
JWT_REFRESH_EXPIRES_IN=7d
BASE_DOMAIN=tudominio.pe
CORS_ORIGIN=*
```

### 4. Configurar Nginx

```nginx
# /etc/nginx/sites-available/vetclinic

# API Backend
server {
    listen 80;
    server_name api.tudominio.pe;

    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}

# Frontend (wildcard subdominios)
server {
    listen 80;
    server_name ~^(?<tenant>.+)\.tudominio\.pe$;

    root /var/www/vetclinic/frontend;
    index dashboard.html;

    location /api/ {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Tenant-Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /socket.io/ {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header X-Tenant-Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location / {
        try_files $uri $uri.html $uri/ /dashboard.html;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/vetclinic /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 5. Lanzar con PM2

```bash
pm2 start src/index.js --name vetclinic-api
pm2 save
pm2 startup
```

### 6. SSL con Let's Encrypt

```bash
sudo certbot --nginx -d tudominio.pe -d *.tudominio.pe \
  --server https://acme-v02.api.letsencrypt.org/directory
```

### 7. Configurar DNS en GoDaddy

```
Tipo    Nombre    Valor           TTL
A       @         IP_DEL_VPS      600
A       *         IP_DEL_VPS      600
A       api       IP_DEL_VPS      600
CNAME   www       @               600
```

---

## 📋 Módulos por plan

| Módulo | Basic S/.69 | Pro S/.79 | Premium S/.119 |
|---|---|---|---|
| Dashboard | ✅ | ✅ | ✅ |
| Citas | ✅ | ✅ | ✅ |
| Propietarios | ✅ | ✅ | ✅ |
| Mascotas + Carnet QR | ✅ | ✅ | ✅ |
| Historia Clínica | ✅ | ✅ | ✅ |
| Servicios | ✅ | ✅ | ✅ |
| Inventario | ❌ | ✅ | ✅ |
| Reportes | ❌ | ✅ | ✅ |
| Facturación | ❌ | ❌ | ✅ |
| Cierre de Caja | ❌ | ❌ | ✅ |
| Consentimientos | ❌ | ❌ | ✅ |
| Usuarios | ❌ | ❌ | ✅ |
| Configuración | ❌ | ❌ | ✅ |
| Max usuarios | 3 | 5 | 10 |

---

## 🔄 Cómo funciona el multitenant

```
Request: GET https://bet.tudominio.pe/api/v1/citas
         ↓
Nginx agrega header X-Tenant-Host: bet.tudominio.pe
         ↓
tenant.middleware.js lee el subdominio
         ↓
Busca en vet_master.tenants → encuentra "Bet Cat"
         ↓
Obtiene pool de conexión para vet_bet (con caché 5 min)
         ↓
req.db = pool de vet_bet
req.tenant = { id, plan, config... }
         ↓
La ruta usa req.db.query() → datos de vet_bet únicamente
```

---

## 🗄️ Bases de datos

```
vet_master          ← orquestador
  ├── tenants
  ├── tenant_config
  ├── tenant_permisos
  ├── tenant_logs
  └── admin_usuarios

vet_bet             ← Clínica "Bet Cat"
vet_patitas         ← Clínica "Patitas"
vet_petdog          ← Clínica "Pet Dog"
  └── (20 tablas: usuarios, mascotas, citas,
       historia_clinica, facturas, inventario,
       caja_cierres, carnets_digitales,
       consentimientos_plantillas, etc.)
```

---

## 🔧 Comandos útiles

```bash
# Ver logs en tiempo real
pm2 logs vetclinic-api

# Reiniciar tras actualización
git pull && pm2 restart vetclinic-api

# Ver estado
pm2 status

# Test de salud del API
curl https://api.tudominio.pe/health
```

---

## 🌟 Características principales

- **Multitenant real** — cada clínica tiene su propia BD aislada
- **Branding dinámico** — logo, nombre y colores por clínica
- **Carnet digital QR** — acceso público sin login para propietarios
- **Consentimientos informados** — 8 plantillas + generador con IA
- **Facturación** — boletas/facturas con IGV, pagos mixtos, anulación
- **Inventario** — con descuento automático al facturar
- **Cierre de caja** — por turno con conteo físico
- **Reportes** — 7 tipos con exportación Excel y PDF
- **Socket.io** — citas, stock y notificaciones en tiempo real
- **Suspensión** — cierre forzado de sesiones con motivo
- **Multimoneda** — configurable por clínica (S/., $, €, etc.)

sudo nano /etc/nginx/sites-available/vetclinic