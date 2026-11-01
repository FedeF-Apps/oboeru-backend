import http from 'node:http';
import { eq, and, lte, gt, type SQL } from 'drizzle-orm';
import { db, pool } from './db/index.js';
import { users, vocabulary, srsReviews } from './db/schema.js';
import { hashPassword, verifyPassword, signJwt, verifyJwt } from './auth/crypto.js';
import { calculateNextReview, type ReviewRating, type SrsState } from './srs/sm2.js';

const PORT = Number(process.env.PORT || 3000);
// CRÍTICO (KAMAL_GUIDELINES.md §2.4): Escuchar en 0.0.0.0 para que kamal-proxy alcance el contenedor
const HOSTNAME = process.env.HOSTNAME || '0.0.0.0';

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
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
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
      const body = await readJsonBody<{ email?: string; password?: string }>(req);
      const email = body.email?.trim().toLowerCase();
      const password = body.password;

      if (!email || !password || password.length < 8) {
        sendJson(res, 400, {
          error: 'Se requiere un email válido y una contraseña de al menos 8 caracteres.',
        });
        return;
      }

      const passwordHash = await hashPassword(password);
      const [created] = await db
        .insert(users)
        .values({ email, passwordHash })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id, email: users.email, createdAt: users.createdAt });

      if (!created) {
        sendJson(res, 409, { error: 'El email ya está registrado.' });
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
        sendJson(res, 400, { error: 'Email y contraseña requeridos.' });
        return;
      }

      const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        sendJson(res, 401, { error: 'Credenciales inválidas.' });
        return;
      }

      const token = signJwt(user.id, user.email);
      sendJson(res, 200, {
        token,
        user: { id: user.id, email: user.email, createdAt: user.createdAt },
      });
      return;
    }

    // ========================================================================
    // 4. Diccionario Offline-First con soporte Delta Sync (?since=ISO_DATE&jlpt=5)
    // ========================================================================
    if (req.method === 'GET' && url.pathname === '/api/v1/vocabulary') {
      const serverTime = new Date().toISOString();
      const jlptParam = url.searchParams.get('jlpt');
      const sinceDate = parseSinceParam(url.searchParams.get('since'));
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 200)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));

      const filters: SQL[] = [];
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
    // 5. Pull Delta de Repasos SRS (GET /api/v1/sync/reviews?since=ISO_DATE&due_only=true)
    // ========================================================================
    if (req.method === 'GET' && url.pathname === '/api/v1/sync/reviews') {
      const authUser = getAuthenticatedUser(req);
      if (!authUser) {
        sendJson(res, 401, { error: 'No autorizado. Incluí Header Authorization: Bearer <token>.' });
        return;
      }

      const serverTime = new Date().toISOString();
      const dueOnly = url.searchParams.get('due_only') === 'true';
      const sinceDate = parseSinceParam(url.searchParams.get('since'));

      const filters: SQL[] = [eq(srsReviews.userId, authUser.sub)];
      if (dueOnly) {
        filters.push(lte(srsReviews.nextReviewDate, new Date()));
      }
      if (sinceDate) {
        filters.push(gt(srsReviews.updatedAt, sinceDate));
      }

      const reviews = await db
        .select()
        .from(srsReviews)
        .where(and(...filters));

      sendJson(res, 200, {
        data: reviews,
        count: reviews.length,
        serverTime,
      });
      return;
    }

    // ========================================================================
    // 6. Push / Sincronización Lote de Repasos SRS con Resolución de Conflictos
    // (Last-Write-Wins mediante updated_at / reviewed_at)
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
      }

      const body = await readJsonBody<{ reviews?: IncomingReviewItem[] }>(req);
      if (!Array.isArray(body.reviews) || body.reviews.length === 0) {
        sendJson(res, 400, { error: 'Se requiere un array "reviews" con al menos un elemento.' });
        return;
      }

      const client = await pool.connect();
      const synced: unknown[] = [];
      let skippedStaleCount = 0;

      try {
        await client.query('BEGIN');

        for (const item of body.reviews) {
          if (!item.vocabulary_id) continue;

          const clientTimestampRaw = item.updated_at || item.reviewed_at;
          const reviewTimestamp = clientTimestampRaw ? new Date(clientTimestampRaw) : new Date();

          let nextState: SrsState = item.state || 'new';
          let nextEase = item.ease_factor ?? 2.5;
          let nextInterval = item.interval_days ?? 0;
          let nextDate = item.next_review_date ? new Date(item.next_review_date) : new Date();
          let nextLapses = item.lapses ?? 0;

          // Si la app envía una calificación (1..4), calculamos el nuevo estado con SM-2
          if (item.rating && [1, 2, 3, 4].includes(item.rating)) {
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

          // Upsert con resolución de conflictos Last-Write-Wins (WHERE EXCLUDED.updated_at >= srs_reviews.updated_at)
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
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (user_id, vocabulary_id)
            DO UPDATE SET
              state = EXCLUDED.state,
              ease_factor = EXCLUDED.ease_factor,
              interval_days = EXCLUDED.interval_days,
              next_review_date = EXCLUDED.next_review_date,
              lapses = EXCLUDED.lapses,
              updated_at = EXCLUDED.updated_at
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
    console.error('❌ [API Error]:', error);
    sendJson(res, 500, { error: 'Internal Server Error' });
  }
});

server.listen(PORT, HOSTNAME, () => {
  console.log(`🚀 [Oboeru API] Servidor escuchando en http://${HOSTNAME}:${PORT}`);
});
