import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  console.log('🚀 [Migrations] Iniciando ejecución de migraciones SQL...');
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const migrationsDir = path.resolve(__dirname, '../../migrations');
    const files = (await fs.readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rowCount } = await client.query(
        'SELECT 1 FROM _schema_migrations WHERE filename = $1',
        [file]
      );

      if (rowCount && rowCount > 0) {
        console.log(`⏭️  [Migrations] Saltando ${file} (ya aplicada).`);
        continue;
      }

      console.log(`📦 [Migrations] Aplicando ${file}...`);
      const sqlContent = await fs.readFile(path.join(migrationsDir, file), 'utf-8');

      await client.query(sqlContent);
      await client.query(
        'INSERT INTO _schema_migrations (filename) VALUES ($1)',
        [file]
      );
      console.log(`✅ [Migrations] ${file} aplicada con éxito.`);
    }

    console.log('🎉 [Migrations] Esquema actualizado correctamente.');
  } catch (error) {
    console.error('❌ [Migrations] Error ejecutando migraciones:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();

