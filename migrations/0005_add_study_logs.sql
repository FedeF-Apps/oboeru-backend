-- ============================================================================
-- Oboeru - Registro Diario de Consistencia de Estudio (study_logs)
-- Migración: 0005_add_study_logs.sql
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS study_logs (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date_key VARCHAR(10) NOT NULL, -- Formato 'YYYY-MM-DD'
    reviews_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, date_key)
);

CREATE INDEX IF NOT EXISTS idx_study_logs_user_updated_at
    ON study_logs (user_id, updated_at);

COMMIT;

