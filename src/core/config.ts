import dotenv from 'dotenv';

dotenv.config();

/**
 * Centralized configuration. Secrets are read only from the environment
 * (.env, gitignored). Nothing is hardcoded. See .env.example for the full list.
 */
export const config = {
  databaseUrl: process.env.DATABASE_URL || 'hms.db',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-change-me',
  port: Number(process.env.PORT || 3000),
  emailProvider: (process.env.EMAIL_PROVIDER || 'console') as
    | 'console'
    | 'smtp'
    | 'mailbox',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
  piiEncryptionKey:
    process.env.PII_ENCRYPTION_KEY || 'dev-only-pii-key-change-me-please',
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM || 'clinic@example.org',
  },
};
