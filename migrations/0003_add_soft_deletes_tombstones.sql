-- ============================================================================
-- Oboeru - Soft-Deletes (Tombstones) y Protección de UUIDs de Vocabulario
-- Migración: 0003_add_soft_deletes_tombstones.sql
-- ============================================================================

-- Nota: ALTER TYPE ... ADD VALUE IF NOT EXISTS se ejecuta fuera de bloque transaccional
-- o al inicio en PostgreSQL 12+
ALTER TYPE srs_state ADD VALUE IF NOT EXISTS 'deleted';

BEGIN;

-- 1. Columna deleted_at (Tombstone) en srs_reviews para sincronización offline-first de bajas
ALTER TABLE srs_reviews
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

-- 2. Proteger la estabilidad de los UUIDs en vocabulary:
-- Cambiar la FK de srs_reviews.vocabulary_id a ON DELETE RESTRICT para impedir
-- que un borrado accidental en el catálogo rompa el historial de los usuarios.
ALTER TABLE srs_reviews
    DROP CONSTRAINT IF EXISTS srs_reviews_vocabulary_id_fkey;

ALTER TABLE srs_reviews
    ADD CONSTRAINT srs_reviews_vocabulary_id_fkey
    FOREIGN KEY (vocabulary_id) REFERENCES vocabulary(id) ON DELETE RESTRICT;

COMMIT;
