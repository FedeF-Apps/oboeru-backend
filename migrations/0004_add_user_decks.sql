-- ============================================================================
-- Oboeru - Nombre Completo en Usuarios (full_name), Usuario de Prueba QA y
--          Mazos Personalizados (user_decks)
-- Migración: 0004_add_user_decks.sql
-- ============================================================================

BEGIN;

-- 1. Agregar campo full_name (Nombre y Apellido en un solo campo) a la tabla users
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS full_name VARCHAR(120) NOT NULL DEFAULT '';

-- Asegurar restricción UNIQUE en email (insensible a mayúsculas/minúsculas ya normalizado por la API)
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower
    ON users (LOWER(email));

-- 2. Sembrar Usuario de Prueba Oficial para QA, Desarrollo y Agentes IA (ver TEST_USER.md)
INSERT INTO users (id, full_name, email, password_hash)
VALUES (
    '00000000-0000-4000-8000-000000000099',
    'Usuario de Prueba',
    'test@oboeru.app',
    'a1b2c3d4e5f60718293a4b5c6d7e8f90:11937a0cfc32c0ab397d13ea524cfffba49ee6fa62c4dc465abaed981b2432dce7d73c5c92c701fef607c86ccdfcfd8dc70c07a6a90bf68838480861d45871dc'
)
ON CONFLICT (email)
DO UPDATE SET
    full_name = EXCLUDED.full_name,
    password_hash = EXCLUDED.password_hash;

-- 3. Crear tabla de mazos personalizados por usuario (user_decks)
CREATE TABLE IF NOT EXISTS user_decks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    description TEXT NULL,
    vocabulary_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_user_decks_user_updated_at
    ON user_decks (user_id, updated_at);

COMMIT;
