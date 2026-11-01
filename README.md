# Oboeru Backend (API REST + Worker ETL)

Backend para **Oboeru**, aplicación móvil offline-first de flashcards para aprender japonés con algoritmo SRS (estilo Anki). Construido sobre el estándar de infraestructura de [`FedeF-Apps/vps-kamal-template`](https://github.com/FedeF-Apps/vps-kamal-template) para despliegue en VPS Ubuntu mediante **Kamal 2**, **Docker** y **GitHub Actions**.

## 📂 Estructura del Proyecto

```text
oboeru-backend/
├── .github/workflows/
│   └── deploy.yml                  # CI/CD: Build en GHCR + Auto-URL-Encoding + Deploy Kamal 2
├── config/
│   └── deploy.yml                  # Configuración Kamal 2 (kamal-proxy, healthcheck /api/health, aliases)
├── migrations/
│   └── 0001_initial_schema.sql     # Esquema SQL inicial (users, vocabulary, srs_reviews)
├── src/
│   ├── db/
│   │   ├── index.ts                # Pool de conexión PostgreSQL + instancia Drizzle ORM
│   │   ├── schema.ts               # Definición tipada del esquema en Drizzle ORM
│   │   └── migrate.ts              # Runner transaccional de migraciones SQL
│   ├── etl/
│   │   └── worker.ts               # Worker ETL para ingesta/actualización del diccionario japonés
│   └── index.ts                    # Servidor API REST (incluye GET /api/health en 0ms)
├── Dockerfile                      # Multi-stage build Node 22 Alpine sin secretos en capas
├── drizzle.config.ts               # Configuración de Drizzle Kit
└── KAMAL_GUIDELINES.md             # Reglas operativas de infraestructura Kamal 2
```

## 🛠️ Comandos Principales

```bash
# Instalar dependencias
npm install

# Desarrollo local (API con hot-reload)
npm run dev

# Ejecutar migraciones contra la base de datos configurada en DATABASE_URL
npm run db:migrate

# Ejecutar el proceso ETL para poblar el diccionario
npm run etl:run

# Compilar para producción
npm run build
```

## 🚀 Ejecución de Migraciones y ETL en Producción (vía Kamal)

Una vez desplegado el contenedor en el VPS, podés disparar las migraciones o el worker ETL utilizando los aliases definidos en `config/deploy.yml`:

```bash
kamal migrate
kamal etl
```

