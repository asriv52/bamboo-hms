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
