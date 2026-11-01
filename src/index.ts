import http from 'node:http';
import { eq, and, or, ne, isNull, ilike, lte, gt, inArray, type SQL } from 'drizzle-orm';
import { db, pool } from './db/index.js';
import { users, vocabulary, srsReviews, userDecks } from './db/schema.js';
import { hashPassword, verifyPassword, signJwt, verifyJwt } from './auth/crypto.js';
import { calculateNextReview, type ReviewRating, type SrsState } from './srs/sm2.js';

const PORT = Number(process.env.PORT || 3000);
// CRÍTICO (KAMAL_GUIDELINES.md §2.4): Escuchar en 0.0.0.0 para que kamal-proxy alcance el contenedor
const HOSTNAME = process.env.HOSTNAME || '0.0.0.0';

// Límites de seguridad para evitar bloqueos del Event Loop de Node.js y rechazos en kamal-proxy
const MAX_SYNC_BATCH_SIZE = 200;
const MAX_BODY_BYTES = 512 * 1024; // 512 KB

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalBytes += buf.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error('PAYLOAD_TOO_LARGE');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return (raw ? JSON.parse(raw) : {}) as T;
}

function getAuthenticatedUser(req: http.IncomingMessage) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return verifyJwt(token);
}

function parseSinceParam(sinceRaw: string | null): Date | null {
  if (!sinceRaw) return null;
  const d = new Date(sinceRaw);
  return Number.isNaN(d.getTime()) ? null : d;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  try {
    // ========================================================================
    // 1. Healthcheck requerido por Kamal 2 (0ms, sin bloqueo de BD)
    // ========================================================================
    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OK');
      return;
    }

    // ========================================================================
    // 2. Autenticación: Registro (POST /api/v1/auth/register)
    // ========================================================================
    if (req.method === 'POST' && url.pathname === '/api/v1/auth/register') {
      const body = await readJsonBody<{
        fullName?: string;
        full_name?: string;
        email?: string;
        password?: string;
      }>(req);
      const fullName = (body.fullName ?? body.full_name ?? '').trim();
      const email = body.email?.trim().toLowerCase();
      const password = body.password;

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (!fullName || fullName.length < 2) {
        sendJson(res, 400, {
          error: 'Ingresá tu nombre (mínimo 2 caracteres).',
        });
        return;
      }

      if (!email || !emailRegex.test(email)) {
        sendJson(res, 400, {
          error: 'Ingresá un correo electrónico válido.',
        });
        return;
      }

      if (!password || password.length < 8) {
        sendJson(res, 400, {
          error: 'La contraseña debe tener al menos 8 caracteres.',
        });
        return;
      }

      const passwordHash = await hashPassword(password);
      const [created] = await db
        .insert(users)
        .values({
          fullName: fullName.slice(0, 120),
          email,
          passwordHash,
        })
        .onConflictDoNothing({ target: users.email })
        .returning({
          id: users.id,
          fullName: users.fullName,
          email: users.email,
          createdAt: users.createdAt,
        });

      if (!created) {
        sendJson(res, 409, {
          error: 'Ya existe una cuenta registrada con este correo electrónico.',
        });
        return;
      }

      const token = signJwt(created.id, created.email);
      sendJson(res, 201, { token, user: created });
      return;
    }

    // ========================================================================
    // 3. Autenticación: Login (POST /api/v1/auth/login)
    // ========================================================================
    if (req.method === 'POST' && url.pathname === '/api/v1/auth/login') {
      const body = await readJsonBody<{ email?: string; password?: string }>(req);
      const email = body.email?.trim().toLowerCase();
      const password = body.password;

      if (!email || !password) {
        sendJson(res, 400, { error: 'Correo electrónico y contraseña requeridos.' });
        return;
      }

      const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        sendJson(res, 401, { error: 'Correo o contraseña incorrectos.' });
        return;
      }

      const token = signJwt(user.id, user.email);
      sendJson(res, 200, {
        token,
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          createdAt: user.createdAt,
        },
      });
      return;
    }

    // ========================================================================
    // 4. Catálogo de Diccionario: Búsqueda puntual (?q=, ?kana=, ?ids=) o por Nivel (?jlpt=4)
    // Soporta también Delta Sync (?since=ISO_DATE)
    // ========================================================================
    if (req.method === 'GET' && url.pathname === '/api/v1/vocabulary') {
      const serverTime = new Date().toISOString();
      const queryText = url.searchParams.get('q')?.trim();
      const kanaText = url.searchParams.get('kana')?.trim();
      const idsParam = url.searchParams.get('ids')?.trim();
      const jlptParam = url.searchParams.get('jlpt');
      const sinceDate = parseSinceParam(url.searchParams.get('since'));
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 100)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));

      const filters: SQL[] = [];

      if (idsParam) {
        const idList = idsParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 200);
        if (idList.length > 0) {
          filters.push(inArray(vocabulary.id, idList));
        }
      }

      if (queryText) {
        const pattern = `%${queryText}%`;
        const orClauses: SQL[] = [
          ilike(vocabulary.kanji, pattern),
          ilike(vocabulary.reading, pattern),
          ilike(vocabulary.meaningEs, pattern),
          ilike(vocabulary.meaningEn, pattern)
        ];

        if (kanaText && kanaText !== queryText) {
          const kanaPattern = `%${kanaText}%`;
          orClauses.push(ilike(vocabulary.reading, kanaPattern));
          orClauses.push(ilike(vocabulary.kanji, kanaPattern));
        }

        const searchCondition = or(...orClauses);
        if (searchCondition) filters.push(searchCondition);
      }

      if (jlptParam) {
        filters.push(eq(vocabulary.jlptLevel, Number(jlptParam)));
      }

      if (sinceDate) {
        filters.push(gt(vocabulary.updatedAt, sinceDate));
      }

      const items =
        filters.length > 0
          ? await db
              .select()
              .from(vocabulary)
              .where(and(...filters))
              .limit(limit)
              .offset(offset)
          : await db.select().from(vocabulary).limit(limit).offset(offset);

      sendJson(res, 200, {
        data: items,
        count: items.length,
        limit,
        offset,
        serverTime,
      });
      return;
    }

    // ========================================================================
    // 5. Pull Delta de Palabras y Repasos Elegidos por el Usuario
    // (GET /api/v1/sync/reviews?since=ISO_DATE&due_only=true)
    // - Si se pasa ?since=, incluye registros con state='deleted' (Tombstones)
    //   para que otros dispositivos del usuario se enteren de las bajas.
    // - Si NO se pasa ?since= (descarga inicial en teléfono nuevo), filtra
    //   automáticamente las eliminadas (state != 'deleted' AND deleted_at IS NULL).
    // ========================================================================
    if (req.method === 'GET' && url.pathname === '/api/v1/sync/reviews') {
      const authUser = getAuthenticatedUser(req);
      if (!authUser) {
        sendJson(res, 401, { error: 'No autorizado. Incluí Header Authorization: Bearer <token>.' });
        return;
      }

      const serverTime = new Date().toISOString();
      const dueOnly = url.searchParams.get('due_only') === 'true';
      const includeDeleted = url.searchParams.get('include_deleted') === 'true';
      const sinceDate = parseSinceParam(url.searchParams.get('since'));

      const filters: SQL[] = [eq(srsReviews.userId, authUser.sub)];

      if (dueOnly) {
        filters.push(lte(srsReviews.nextReviewDate, new Date()));
        filters.push(ne(srsReviews.state, 'deleted'));
        filters.push(isNull(srsReviews.deletedAt));
      } else if (sinceDate) {
        // En Delta Sync devolvemos también los tombstones (state='deleted') ocurridos desde sinceDate
        filters.push(
          or(gt(srsReviews.updatedAt, sinceDate), gt(vocabulary.updatedAt, sinceDate))!
        );
      } else if (!includeDeleted) {
        // En carga inicial (sin ?since=), omitimos las palabras borradas
        filters.push(ne(srsReviews.state, 'deleted'));
        filters.push(isNull(srsReviews.deletedAt));
      }

      const rows = await db
        .select({
          id: srsReviews.id,
          userId: srsReviews.userId,
          vocabularyId: srsReviews.vocabularyId,
          state: srsReviews.state,
          easeFactor: srsReviews.easeFactor,
          intervalDays: srsReviews.intervalDays,
          nextReviewDate: srsReviews.nextReviewDate,
          lapses: srsReviews.lapses,
          updatedAt: srsReviews.updatedAt,
          deletedAt: srsReviews.deletedAt,
          vocabulary: {
            id: vocabulary.id,
            kanji: vocabulary.kanji,
            reading: vocabulary.reading,
            meaningEs: vocabulary.meaningEs,
            meaningEn: vocabulary.meaningEn,
            jlptLevel: vocabulary.jlptLevel,
            partOfSpeech: vocabulary.partOfSpeech,
            exampleSentence: vocabulary.exampleSentence,
            updatedAt: vocabulary.updatedAt,
          },
        })
        .from(srsReviews)
        .innerJoin(vocabulary, eq(srsReviews.vocabularyId, vocabulary.id))
        .where(and(...filters));

      sendJson(res, 200, {
        data: rows,
        count: rows.length,
        serverTime,
      });
      return;
    }

    // ========================================================================
    // 6. Push / Sincronización en Lotes (Chunks de máx. 200 registros)
    // (POST /api/v1/sync/reviews)
    // Soporta:
    // - Alta de palabras al estudio (state='new')
    // - Soft-Delete / Tombstone (state='deleted' o deleted_at)
    // - Sincronización SRS con resolución Last-Write-Wins (updated_at)
    // ========================================================================
    if (req.method === 'POST' && url.pathname === '/api/v1/sync/reviews') {
      const authUser = getAuthenticatedUser(req);
      if (!authUser) {
        sendJson(res, 401, { error: 'No autorizado. Incluí Header Authorization: Bearer <token>.' });
        return;
      }

      interface IncomingReviewItem {
        vocabulary_id: string;
        rating?: ReviewRating;
        state?: SrsState;
        ease_factor?: number;
        interval_days?: number;
        next_review_date?: string;
        lapses?: number;
        updated_at?: string;
        reviewed_at?: string;
        deleted_at?: string | null;
        deleted?: boolean;
      }

      const body = await readJsonBody<{ reviews?: IncomingReviewItem[] }>(req);
      if (!Array.isArray(body.reviews) || body.reviews.length === 0) {
        sendJson(res, 400, { error: 'Se requiere un array "reviews" con al menos un elemento.' });
        return;
      }

      // Validación estricta de tamaño de chunk (máximo 200 registros por request)
      if (body.reviews.length > MAX_SYNC_BATCH_SIZE) {
        sendJson(res, 413, {
          error: `El lote supera el máximo permitido de ${MAX_SYNC_BATCH_SIZE} registros por petición (recibidos: ${body.reviews.length}). Dividí la sincronización en chunks de hasta ${MAX_SYNC_BATCH_SIZE} elementos.`,
          maxBatchSize: MAX_SYNC_BATCH_SIZE,
        });
        return;
      }

      const client = await pool.connect();
      const synced: unknown[] = [];
      let skippedStaleCount = 0;

      try {
        await client.query('BEGIN');

        // Pre-validación de claves foráneas: verificar qué vocabulary_ids existen en la base de datos
        // para evitar abortar la transacción por referencias inexistentes o semillas locales antiguas.
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const incomingVocabIds = Array.from(
          new Set(
            body.reviews
              .map((r) => r.vocabulary_id)
              .filter((id): id is string => Boolean(id && uuidRegex.test(id)))
          )
        );
        const validVocabSet = new Set<string>();

        if (incomingVocabIds.length > 0) {
          const vocabCheckRes = await client.query(
            `SELECT id FROM vocabulary WHERE id = ANY($1::uuid[])`,
            [incomingVocabIds]
          );
          for (const row of vocabCheckRes.rows) {
            validVocabSet.add(row.id);
          }
        }

        for (const item of body.reviews) {
          if (!item.vocabulary_id || !validVocabSet.has(item.vocabulary_id)) {
            skippedStaleCount++;
            continue;
          }

          const clientTimestampRaw = item.updated_at || item.reviewed_at || item.deleted_at;
          const reviewTimestamp = clientTimestampRaw ? new Date(clientTimestampRaw) : new Date();

          const isSoftDeleted =
            item.state === 'deleted' || item.deleted === true || Boolean(item.deleted_at);

          let nextState: SrsState = isSoftDeleted ? 'deleted' : item.state || 'new';
          let nextEase = item.ease_factor ?? 2.5;
          let nextInterval = item.interval_days ?? 0;
          let nextDate = item.next_review_date ? new Date(item.next_review_date) : new Date();
          let nextLapses = item.lapses ?? 0;
          const nextDeletedAt: string | null = isSoftDeleted
            ? (item.deleted_at ? new Date(item.deleted_at) : reviewTimestamp).toISOString()
            : null;

          // Si no es un borrado y la app envía una calificación (1..4), calculamos SM-2
          if (!isSoftDeleted && item.rating && [1, 2, 3, 4].includes(item.rating)) {
            const existingRes = await client.query(
              `SELECT state, ease_factor, interval_days, lapses
               FROM srs_reviews
               WHERE user_id = $1 AND vocabulary_id = $2`,
              [authUser.sub, item.vocabulary_id]
            );
            const currentCard = existingRes.rows[0]
              ? {
                  state: existingRes.rows[0].state as SrsState,
                  easeFactor: Number(existingRes.rows[0].ease_factor),
                  intervalDays: Number(existingRes.rows[0].interval_days),
                  lapses: Number(existingRes.rows[0].lapses),
                }
              : {
                  state: nextState,
                  easeFactor: nextEase,
                  intervalDays: nextInterval,
                  lapses: nextLapses,
                };

            const calculated = calculateNextReview(currentCard, item.rating, reviewTimestamp);
            nextState = calculated.state;
            nextEase = calculated.easeFactor;
            nextInterval = calculated.intervalDays;
            nextDate = calculated.nextReviewDate;
            nextLapses = calculated.lapses;
          }

          // Upsert con soporte de Soft-Delete (Tombstone) y Last-Write-Wins
          const { rows } = await client.query(
            `
            INSERT INTO srs_reviews (
              user_id,
              vocabulary_id,
              state,
              ease_factor,
              interval_days,
              next_review_date,
              lapses,
              updated_at,
              deleted_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (user_id, vocabulary_id)
            DO UPDATE SET
              state = EXCLUDED.state,
              ease_factor = EXCLUDED.ease_factor,
              interval_days = EXCLUDED.interval_days,
              next_review_date = EXCLUDED.next_review_date,
              lapses = EXCLUDED.lapses,
              updated_at = EXCLUDED.updated_at,
              deleted_at = EXCLUDED.deleted_at
            WHERE EXCLUDED.updated_at >= srs_reviews.updated_at
            RETURNING *;
            `,
            [
              authUser.sub,
              item.vocabulary_id,
              nextState,
              nextEase,
              nextInterval,
              nextDate.toISOString(),
              nextLapses,
              reviewTimestamp.toISOString(),
              nextDeletedAt,
            ]
          );

          if (rows[0]) {
            synced.push(rows[0]);
          } else {
            skippedStaleCount++;
          }
        }

        await client.query('COMMIT');
        sendJson(res, 200, {
          syncedCount: synced.length,
          skippedStaleCount,
          maxBatchSize: MAX_SYNC_BATCH_SIZE,
          serverTime: new Date().toISOString(),
          data: synced,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return;
    }

    // ========================================================================
    // 7. Pull Delta de Mazos Personalizados del Usuario
    // (GET /api/v1/sync/decks?since=ISO_DATE)
    // ========================================================================
    if (req.method === 'GET' && url.pathname === '/api/v1/sync/decks') {
      const authUser = getAuthenticatedUser(req);
      if (!authUser) {
        sendJson(res, 401, { error: 'No autorizado. Incluí Header Authorization: Bearer <token>.' });
        return;
      }

      const serverTime = new Date().toISOString();
      const sinceDate = parseSinceParam(url.searchParams.get('since'));
      const includeDeleted = url.searchParams.get('include_deleted') === 'true';

      const filters: SQL[] = [eq(userDecks.userId, authUser.sub)];

      if (sinceDate) {
        filters.push(gt(userDecks.updatedAt, sinceDate));
      } else if (!includeDeleted) {
        filters.push(isNull(userDecks.deletedAt));
      }

      const rows = await db
        .select()
        .from(userDecks)
        .where(and(...filters));

      sendJson(res, 200, {
        data: rows,
        count: rows.length,
        serverTime,
      });
      return;
    }

    // ========================================================================
    // 8. Push / Sincronización de Mazos Personalizados (LWW + Tombstones)
    // (POST /api/v1/sync/decks)
    // ========================================================================
    if (req.method === 'POST' && url.pathname === '/api/v1/sync/decks') {
      const authUser = getAuthenticatedUser(req);
      if (!authUser) {
        sendJson(res, 401, { error: 'No autorizado. Incluí Header Authorization: Bearer <token>.' });
        return;
      }

      interface IncomingDeckItem {
        id: string;
        name: string;
        description?: string | null;
        vocabulary_ids?: string[];
        created_at?: string;
        updated_at?: string;
        deleted_at?: string | null;
      }

      const body = await readJsonBody<{ decks?: IncomingDeckItem[] }>(req);
      if (!Array.isArray(body.decks) || body.decks.length === 0) {
        sendJson(res, 400, { error: 'Se requiere un array "decks" con al menos un elemento.' });
        return;
      }

      if (body.decks.length > MAX_SYNC_BATCH_SIZE) {
        sendJson(res, 413, {
          error: `El lote supera el máximo permitido de ${MAX_SYNC_BATCH_SIZE} mazos por petición.`,
          maxBatchSize: MAX_SYNC_BATCH_SIZE,
        });
        return;
      }

      const client = await pool.connect();
      const synced: unknown[] = [];
      let skippedStaleCount = 0;

      try {
        await client.query('BEGIN');

        for (const item of body.decks) {
          if (!item.id || !item.name?.trim()) continue;

          const updatedAt = item.updated_at ? new Date(item.updated_at) : new Date();
          const createdAt = item.created_at ? new Date(item.created_at) : updatedAt;
          const deletedAt = item.deleted_at ? new Date(item.deleted_at).toISOString() : null;
          const vocabIdsJson = JSON.stringify(
            Array.isArray(item.vocabulary_ids) ? item.vocabulary_ids : []
          );

          const { rows } = await client.query(
            `
            INSERT INTO user_decks (
              id,
              user_id,
              name,
              description,
              vocabulary_ids,
              created_at,
              updated_at,
              deleted_at
            )
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
            ON CONFLICT (id)
            DO UPDATE SET
              name = EXCLUDED.name,
              description = EXCLUDED.description,
              vocabulary_ids = EXCLUDED.vocabulary_ids,
              updated_at = EXCLUDED.updated_at,
              deleted_at = EXCLUDED.deleted_at
            WHERE user_decks.user_id = $2
              AND EXCLUDED.updated_at >= user_decks.updated_at
            RETURNING *;
            `,
            [
              item.id,
              authUser.sub,
              item.name.trim().slice(0, 120),
              item.description?.trim() || null,
              vocabIdsJson,
              createdAt.toISOString(),
              updatedAt.toISOString(),
              deletedAt,
            ]
          );

          if (rows[0]) {
            synced.push(rows[0]);
          } else {
            skippedStaleCount++;
          }
        }

        await client.query('COMMIT');
        sendJson(res, 200, {
          syncedCount: synced.length,
          skippedStaleCount,
          serverTime: new Date().toISOString(),
          data: synced,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return;
    }

    // ========================================================================
    // GET /api/v1/sync/study-logs (Delta Pull de logs de estudio por usuario)
    // ========================================================================
    if (req.method === 'GET' && url.pathname === '/api/v1/sync/study-logs') {
      const authUser = getAuthenticatedUser(req);
      if (!authUser) {
        sendJson(res, 401, { error: 'No autorizado. Incluí Header Authorization: Bearer <token>.' });
        return;
      }

      const sinceParam = url.searchParams.get('since');
      let query = `
        SELECT user_id, date_key, reviews_count, updated_at
        FROM study_logs
        WHERE user_id = $1
      `;
      const params: unknown[] = [authUser.sub];

      if (sinceParam) {
        query += ` AND updated_at > $2`;
        params.push(new Date(sinceParam).toISOString());
      }
      query += ` ORDER BY updated_at ASC;`;

      const { rows } = await pool.query(query, params);
      sendJson(res, 200, {
        serverTime: new Date().toISOString(),
        count: rows.length,
        data: rows,
      });
      return;
    }

    // ========================================================================
    // POST /api/v1/sync/study-logs (Delta Push con resolución LWW)
    // ========================================================================
    if (req.method === 'POST' && url.pathname === '/api/v1/sync/study-logs') {
      const authUser = getAuthenticatedUser(req);
      if (!authUser) {
        sendJson(res, 401, { error: 'No autorizado. Incluí Header Authorization: Bearer <token>.' });
        return;
      }

      const body = await readJsonBody<{
        logs: Array<{
          date_key: string;
          reviews_count: number;
          updated_at?: string;
        }>;
      }>(req);

      if (!body.logs || !Array.isArray(body.logs)) {
        sendJson(res, 400, { error: 'Formato inválido. Se espera { logs: [...] }' });
        return;
      }

      if (body.logs.length > MAX_SYNC_BATCH_SIZE) {
        sendJson(res, 413, {
          error: `El lote supera el máximo permitido de ${MAX_SYNC_BATCH_SIZE} registros por petición.`,
          maxBatchSize: MAX_SYNC_BATCH_SIZE,
        });
        return;
      }

      const client = await pool.connect();
      const synced: unknown[] = [];
      let skippedStaleCount = 0;

      try {
        await client.query('BEGIN');

        for (const item of body.logs) {
          if (!item.date_key) continue;

          const updatedAt = item.updated_at ? new Date(item.updated_at) : new Date();
          const reviewsCount = Math.max(0, Number(item.reviews_count) || 0);

          const { rows } = await client.query(
            `
            INSERT INTO study_logs (
              user_id,
              date_key,
              reviews_count,
              updated_at
            )
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_id, date_key)
            DO UPDATE SET
              reviews_count = EXCLUDED.reviews_count,
              updated_at = EXCLUDED.updated_at
            WHERE EXCLUDED.updated_at >= study_logs.updated_at
            RETURNING *;
            `,
            [
              authUser.sub,
              item.date_key.trim(),
              reviewsCount,
              updatedAt.toISOString(),
            ]
          );

          if (rows[0]) {
            synced.push(rows[0]);
          } else {
            skippedStaleCount++;
          }
        }

        await client.query('COMMIT');
        sendJson(res, 200, {
          syncedCount: synced.length,
          skippedStaleCount,
          serverTime: new Date().toISOString(),
          data: synced,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return;
    }

    // Ruta no encontrada (404)
    sendJson(res, 404, { error: 'Not Found' });
  } catch (error) {
    if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') {
      sendJson(res, 413, {
        error: `El cuerpo de la petición supera el límite de ${MAX_BODY_BYTES / 1024} KB. Enviá los datos en chunks de máximo ${MAX_SYNC_BATCH_SIZE} registros.`,
      });
      return;
    }
    console.error('❌ [API Error]:', error);
    sendJson(res, 500, { error: 'Internal Server Error' });
  }
});

server.listen(PORT, HOSTNAME, () => {
  console.log(`🚀 [Oboeru API] Servidor escuchando en http://${HOSTNAME}:${PORT}`);
});
