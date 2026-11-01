# Kamal 2 Deployment Guidelines & Technical Reference

Este documento reúne las directrices arquitectónicas, reglas de configuración y lecciones aprendidas en producción para desplegar aplicaciones y servicios backend en un servidor VPS remoto utilizando **Kamal 2**, **Docker** y **GitHub Actions** (basado en `FedeF-Apps/vps-kamal-template`).

---

## 1. Topología de Redes Docker en el VPS

1. **`kamal`**: Red principal interna (tipo bridge) creada y gestionada por Kamal Proxy.
   - Todos los contenedores de aplicaciones corren en esta red.
   - El contenedor de base de datos centralizado (`infra-core-postgres`) **DEBE estar conectado a la red `kamal`** para responder directamente a través de su hostname interno de Docker (`infra-core-postgres:5432`).
2. **`shared-net`**: Red secundaria utilizada para servicios auxiliares por fuera del ciclo de vida del proxy de Kamal.

### ⚠️ Regla de Oro:
- **Las aplicaciones NO deben incluir `options: network: "shared-net"` en su `deploy.yml`**.
- **El servicio centralizado de base de datos es el que se une a `kamal`**:
  ```bash
  docker network create kamal 2>/dev/null || true
  docker network connect kamal infra-core-postgres 2>/dev/null || true
  ```

## 2. Particularidades Críticas de Kamal 2

- **Uso obligatorio de `proxy:` con `kamal-proxy`** (nunca `traefik:`).
- **Tipos de datos estrictos en `healthcheck`**: `interval: 5` y `timeout: 3` deben ser números enteros en segundos.
- **Variables obligatorias**: `PORT: 3000` y `HOSTNAME: "0.0.0.0"` en `env.clear`.
- **Compilación en GitHub Actions**: `builder.remote: false`.
- **Cero secretos en Dockerfile**: No declarar `ARG`/`ENV` con nombres como `DATABASE_URL` o `AUTH_SECRET` en el `Dockerfile` para evitar `SecretsUsedInArgOrEnv`.

