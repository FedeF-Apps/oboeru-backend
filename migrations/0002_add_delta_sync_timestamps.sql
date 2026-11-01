-- ============================================================================
-- Oboeru - Sincronización Delta Offline-First (updated_at)
-- Migración: 0002_add_delta_sync_timestamps.sql
-- ============================================================================

BEGIN;

-- 1. Agregar updated_at a vocabulary para pull incremental del diccionario (?since=)
ALTER TABLE vocabulary
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_vocabulary_updated_at
    ON vocabulary (updated_at);

-- 2. Agregar updated_at a srs_reviews para sincronización delta y resolución de conflictos (Last-Write-Wins)
ALTER TABLE srs_reviews
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_srs_reviews_user_updated_at
    ON srs_reviews (user_id, updated_at);

COMMIT;
