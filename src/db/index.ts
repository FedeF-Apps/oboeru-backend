import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn(
    '⚠️ [DB] DATABASE_URL no está definida. Asegurate de configurarla en tu entorno o secrets de Kamal.'
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const db = drizzle(pool, { schema });

