# 📧 Green Elements Mail
Gestor de correo IMAP para jramirez@greenelements.mx

## Instalación

### 1. Instala Node.js
Descarga desde https://nodejs.org (versión LTS)

### 2. Descarga los archivos
Coloca todos los archivos en una carpeta, por ejemplo: `C:\greenelements-mail`

### 3. Configura tu contraseña
- Copia `.env.example` y renómbralo a `.env`
- Abre `.env` con el Bloc de notas
- Cambia `TU_CONTRASEÑA_AQUI` por tu contraseña de correo

### 4. Instala dependencias
Abre una terminal en la carpeta del proyecto y ejecuta:
```
npm install
```

### 5. Inicia la app
```
npm start
```

### 6. Abre en tu navegador
```
http://localhost:3000
```

---

## Configuración del servidor

| Campo | Valor |
|---|---|
| Servidor | mail.greenelements.mx |
| Usuario | jramirez@greenelements.mx |
| IMAP Puerto | 993 (SSL) |
| SMTP Puerto | 465 (SSL) |

---

## Para iniciar automáticamente con Windows
Instala PM2:
```
npm install -g pm2
pm2 start server.js --name "greenelements-mail"
pm2 startup
pm2 save
```
