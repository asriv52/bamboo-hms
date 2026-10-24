import crypto from 'crypto';
import { config } from './config';

/**
 * PII encryption at rest. Uses AES-256-GCM with a key derived from
 * PII_ENCRYPTION_KEY. Stored format: base64(iv).base64(authTag).base64(cipher).
 *
 * This is a demo-grade implementation: the key lives in .env, never in code.
 */
const KEY = crypto.createHash('sha256').update(config.piiEncryptionKey).digest();

export function encryptPII(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptPII(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const [ivB64, tagB64, dataB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      KEY,
      Buffer.from(ivB64, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}

export function hashPassword(password: string, salt?: string): string {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .scryptSync(password, useSalt, 64)
    .toString('hex');
  return `${useSalt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  // constant-time compare
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function randomToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * A short, human-friendly code for reading aloud / typing — used as a per-visit
 * "receipt" access code (e.g. RCPT-7F3K9). Avoids ambiguous characters.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
export function shortCode(prefix = 'RCPT', length = 5): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `${prefix}-${out}`;
}

/** A numeric one-time password (default 6 digits), returned as a string. */
export function numericOtp(digits = 6): string {
  const max = 10 ** digits;
  const n = crypto.randomInt(0, max);
  return n.toString().padStart(digits, '0');
}

/** HMAC-SHA256 of a value with the server secret — used to store OTP codes. */
export function hmacCode(value: string): string {
  return crypto.createHmac('sha256', KEY).update(value).digest('hex');
}

// ---- Wearable de-identification ---------------------------------------------
//
// Wearable data is stored under a RANDOM pseudonym. A pseudonym is not derived
// from any identifier, so it cannot be reversed by hashing candidate patient
// ids. The only way back to the patient ("inverse" lookup) is the
// re-identification vault, which is sealed with a separate key
// (WEARABLE_REID_KEY) and only opened through the access-controlled service.

const REID_KEY = crypto.createHash('sha256').update(config.wearableReidKey).digest();

/** A new random subject pseudonym, e.g. WR-9F2C4A7E1B0D6C3A5E8F1A2B. */
export function randomPseudonym(): string {
  return `WR-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
}

/** Keyed one-way index for the vault (forward lookup without storing the id in clear). */
export function reidIndex(value: string): string {
  return crypto.createHmac('sha256', REID_KEY).update(value).digest('hex');
}

/** Seal a value into the re-identification vault (AES-256-GCM, vault key). */
export function sealReid(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', REID_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

/** Open a vault value. Returns null when tampered or sealed with another key. */
export function openReid(stored: string): string | null {
  const [ivB64, tagB64, dataB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', REID_KEY, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** SHA-256 hex digest (e.g. to pin the exact consent text a patient signed). */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
