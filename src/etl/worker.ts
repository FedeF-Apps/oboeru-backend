import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface RawVocabularyEntry {
  kanji: string | null;
  reading: string;
  meaning_es: string;
  meaning_en: string;
  jlpt_level: number;
  part_of_speech: string;
  example_sentence: string | null;
}

const DEFAULT_DATA_PATH = path.resolve(__dirname, '../../data/jlpt_vocabulary.json');
const BATCH_SIZE = 200;

/**
 * Extrae y valida entradas de vocabulario desde un archivo JSON.
 */
async function extractVocabularyFromFile(filePath: string): Promise<RawVocabularyEntry[]> {
  console.log(`📂 [ETL Extract] Leyendo archivo de diccionario: ${filePath}`);
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(content);

  if (!Array.isArray(parsed)) {
    throw new Error('El archivo de diccionario debe contener un array JSON de objetos.');
  }
  return parsed as RawVocabularyEntry[];
}

/**
 * Transforma, limpia y filtra entradas inválidas antes de insertar en PostgreSQL.
 */
function transformVocabularyEntries(rawEntries: RawVocabularyEntry[]): RawVocabularyEntry[] {
  const validEntries: RawVocabularyEntry[] = [];

  for (const item of rawEntries) {
    const reading = item.reading?.trim();
    const meaningEs = item.meaning_es?.trim();
    const meaningEn = item.meaning_en?.trim();
    const jlpt = Number(item.jlpt_level);

    if (!reading || !meaningEs || !meaningEn || Number.isNaN(jlpt) || jlpt < 1 || jlpt > 5) {
      console.warn(`⚠️ [ETL Transform] Saltando entrada inválida:`, item);
      continue;
    }

    validEntries.push({
      kanji: item.kanji?.trim() || null,
      reading,
      meaning_es: meaningEs,
      meaning_en: meaningEn,
      jlpt_level: jlpt,
      part_of_speech: item.part_of_speech?.trim() || 'unknown',
      example_sentence: item.example_sentence?.trim() || null,
    });
  }

  return validEntries;
}

/**
 * Ejecuta el pipeline ETL completo (Extract -> Transform -> Load en lotes transaccionales).
 */
export async function runVocabularyETL(customFilePath?: string) {
  const targetFile = customFilePath
    ? path.resolve(process.cwd(), customFilePath)
    : DEFAULT_DATA_PATH;

  const rawEntries = await extractVocabularyFromFile(targetFile);
  const entries = transformVocabularyEntries(rawEntries);

  console.log(
    `🔄 [ETL Load] Sincronizando ${entries.length} entradas válidas en lotes de ${BATCH_SIZE}...`
  );

  const client = await pool.connect();
  let totalProcessed = 0;

  try {
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      await client.query('BEGIN');

      for (const item of batch) {
        await client.query(
          `
          INSERT INTO vocabulary (
            kanji,
            reading,
            meaning_es,
            meaning_en,
            jlpt_level,
            part_of_speech,
            example_sentence
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT ((COALESCE(kanji, '')), reading)
          DO UPDATE SET
            meaning_es = EXCLUDED.meaning_es,
            meaning_en = EXCLUDED.meaning_en,
            jlpt_level = EXCLUDED.jlpt_level,
            part_of_speech = EXCLUDED.part_of_speech,
            example_sentence = EXCLUDED.example_sentence;
          `,
          [
            item.kanji,
            item.reading,
            item.meaning_es,
            item.meaning_en,
            item.jlpt_level,
            item.part_of_speech,
            item.example_sentence,
          ]
        );
        totalProcessed++;
      }

      await client.query('COMMIT');
    }

    const { rows } = await client.query(`
      SELECT jlpt_level, COUNT(*)::int AS total
      FROM vocabulary
      GROUP BY jlpt_level
      ORDER BY jlpt_level DESC;
    `);

    console.log(
      `✅ [ETL Worker] Proceso finalizado con éxito. Registros sincronizados: ${totalProcessed}`
    );
    console.log('📊 [ETL Resumen por Nivel JLPT]:', rows);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ [ETL Worker] Falló el proceso ETL, se revirtió el lote:', error);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

if (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js')) {
  const customFile = process.argv[2];
  runVocabularyETL(customFile).finally(() => pool.end());
}
