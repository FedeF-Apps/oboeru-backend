import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

/**
 * Genera un hash seguro de contraseña usando node:crypto scrypt + salt aleatorio.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

/**
 * Verifica una contraseña contra un hash almacenado con comparación en tiempo constante.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, keyHex] = storedHash.split(':');
  if (!salt || !keyHex) return false;

  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, derivedKey) => {
      if (err) return reject(err);
      const keyBuffer = Buffer.from(keyHex, 'hex');
      if (keyBuffer.length !== derivedKey.length) return resolve(false);
      resolve(crypto.timingSafeEqual(keyBuffer, derivedKey));
    });
  });
}

export interface JwtPayload {
  sub: string;
  email: string;
  iat: number;
  exp: number;
}

function getSecret(): string {
  return process.env.AUTH_SECRET || 'dev-fallback-secret-change-in-prod';
}

/**
 * Firma un token JWT (HS256) nativo sin dependencias externas.
 */
export function signJwt(userId: string, email: string, expiresInSeconds = 60 * 60 * 24 * 30): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    sub: userId,
    email,
    iat: now,
    exp: now + expiresInSeconds,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', getSecret())
    .update(`${header}.${payloadB64}`)
    .digest('base64url');

  return `${header}.${payloadB64}.${signature}`;
}

/**
 * Verifica la firma y expiración de un token JWT (HS256).
 */
export function verifyJwt(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, payloadB64, signature] = parts;
  const expectedSig = crypto
    .createHmac('sha256', getSecret())
    .update(`${header}.${payloadB64}`)
    .digest('base64url');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as JwtPayload;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
