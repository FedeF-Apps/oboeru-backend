-- ============================================================================
-- Oboeru - Esquema Inicial PostgreSQL (oboeru_prod)
-- Migración: 0001_initial_schema.sql
-- ============================================================================

BEGIN;

-- Extensión para generación nativa de UUID v4 (disponible también en PG 13+ nativo)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Tipo ENUM para el estado de las tarjetas SRS (estilo Anki)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'srs_state') THEN
        CREATE TYPE srs_state AS ENUM ('new', 'learning', 'review', 'suspended');
    END IF;
END$$;

-- 1. Tabla: users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Tabla: vocabulary
CREATE TABLE IF NOT EXISTS vocabulary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kanji TEXT NULL,
    reading TEXT NOT NULL,
    meaning_es TEXT NOT NULL,
    meaning_en TEXT NOT NULL,
    jlpt_level INTEGER NOT NULL CHECK (jlpt_level BETWEEN 1 AND 5),
    part_of_speech VARCHAR(100) NOT NULL,
    example_sentence TEXT NULL
);

-- Índices para búsqueda rápida y filtrado en el proceso ETL y sincronización
CREATE INDEX IF NOT EXISTS idx_vocabulary_jlpt_level ON vocabulary (jlpt_level);
CREATE INDEX IF NOT EXISTS idx_vocabulary_reading ON vocabulary (reading);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vocabulary_kanji_reading_unique
    ON vocabulary (COALESCE(kanji, ''), reading);

-- 3. Tabla: srs_reviews
CREATE TABLE IF NOT EXISTS srs_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vocabulary_id UUID NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
    state srs_state NOT NULL DEFAULT 'new',
    ease_factor NUMERIC(5, 2) NOT NULL DEFAULT 2.50,
    interval_days INTEGER NOT NULL DEFAULT 0,
    next_review_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lapses INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT uq_srs_reviews_user_vocabulary UNIQUE (user_id, vocabulary_id)
);

-- Índices para cola de estudio SRS y sincronización por usuario
CREATE INDEX IF NOT EXISTS idx_srs_reviews_user_next_review
    ON srs_reviews (user_id, next_review_date);
CREATE INDEX IF NOT EXISTS idx_srs_reviews_user_state
    ON srs_reviews (user_id, state);

COMMIT;

