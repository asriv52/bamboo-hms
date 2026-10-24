/**
 * Input validation helpers. Validation is mandatory on every inbound path.
 * Failures reject with a clear, user-friendly message — never silently drop.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationError('Email is required.');
  }
  const email = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw new ValidationError('Please enter a valid email address.');
  }
  return email;
}

/**
 * Normalize a phone number to a simple E.164-ish form (+<digits>).
 * Returns null when not provided (phone is supplementary, not required).
 */
export function normalizePhone(raw: unknown): string | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null;
  }
  const digits = String(raw).replace(/[^\d+]/g, '');
  const cleaned = digits.startsWith('+') ? digits : `+${digits}`;
  if (!/^\+\d{7,15}$/.test(cleaned)) {
    throw new ValidationError(
      'Phone number must be digits only, 7-15 long, optionally starting with +.'
    );
  }
  return cleaned;
}

export function requireText(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationError(`${field} is required.`);
  }
  return raw.trim();
}

export function optionalText(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.trim();
}

/** Parse a money amount like "12.50" into integer cents (>= 0). */
export function parseMoneyToCents(raw: unknown, field: string): number {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new ValidationError(`${field} must be an amount like 12.50.`);
  }
  return Math.round(parseFloat(s) * 100);
}

/** Parse a whole number within [min, max]. */
export function parseIntInRange(raw: unknown, field: string, min: number, max: number): number {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^-?\d+$/.test(s)) throw new ValidationError(`${field} must be a whole number.`);
  const n = parseInt(s, 10);
  if (n < min || n > max) {
    throw new ValidationError(`${field} must be between ${min} and ${max}.`);
  }
  return n;
}

/** Require the value to be one of an allowed list (case-sensitive). */
export function requireOneOf<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  field: string
): T {
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
  throw new ValidationError(`Choose a valid ${field.toLowerCase()}.`);
}

/**
 * Parse a date-time from a form (e.g. "2026-11-02T09:30"). Values without a
 * zone are treated as UTC — all times are stored and entered in UTC in this
 * build. Optionally requires the time to be in the future.
 */
export function parseDateTimeUtc(raw: unknown, field: string, opts: { future?: boolean } = {}): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(s)) {
    throw new ValidationError(`${field} must be a valid date and time.`);
  }
  const hasZone = /(Z|[+-]\d{2}:\d{2})$/.test(s);
  const d = new Date(hasZone ? s : `${s}Z`);
  if (isNaN(d.getTime())) throw new ValidationError(`${field} must be a valid date and time.`);
  if (opts.future && d.getTime() <= Date.now()) {
    throw new ValidationError(`${field} must be in the future.`);
  }
  return d.toISOString();
}

/** Validate an "HH:MM" 24-hour time string. */
export function requireTimeOfDay(raw: unknown, field: string): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) {
    throw new ValidationError(`${field} must be a time like 09:00.`);
  }
  return s;
}
