import { hmacCode, numericOtp } from './crypto';
import { nowUtc } from './db';
import {
  consumeOtp,
  createOtp,
  getLatestActiveOtp,
  incrementOtpAttempts,
} from './entityStore';
import { enqueueEmail } from './notificationService';

/**
 * Email-delivered one-time password service. No SMS — OTPs are sent only by
 * email through the single notification service. Codes are never stored in
 * plaintext: we persist an HMAC of the code and compare HMACs on verify.
 *
 * A "context" scopes an OTP to a purpose + subject, e.g. `portal:<patientId>`.
 * verifyOtp never reveals whether a context exists — it returns a boolean and
 * callers surface a single generic message on failure.
 */

const OTP_TTL_MINUTES = 10;
const MAX_VERIFY_ATTEMPTS = 5;

export function issueOtp(context: string, targetEmail: string): void {
  const code = numericOtp(6);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString();
  createOtp({
    context,
    targetEmail,
    codeHash: hmacCode(`${context}:${code}`),
    expiresAt,
  });
  // Email delivery is queued; issuing never blocks on the provider.
  enqueueEmail('access_otp', targetEmail, {
    code,
    minutes: OTP_TTL_MINUTES,
  });
}

/**
 * Verify a submitted code for a context. Returns true on success (and consumes
 * the OTP so it cannot be reused). Returns false for wrong / expired / missing
 * / exhausted codes without leaking which.
 */
export function verifyOtp(context: string, submitted: string): boolean {
  const otp = getLatestActiveOtp(context);
  if (!otp) return false;

  if (otp.consumedAt) return false;
  if (otp.expiresAt <= nowUtc()) return false;
  if (otp.attempts >= MAX_VERIFY_ATTEMPTS) return false;

  incrementOtpAttempts(otp.id);

  const expected = otp.codeHash;
  const actual = hmacCode(`${context}:${String(submitted).trim()}`);
  if (expected !== actual) return false;

  consumeOtp(otp.id);
  return true;
}
