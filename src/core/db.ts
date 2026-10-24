import Database from 'better-sqlite3';
import { config } from './config';

/**
 * Single database connection for the core layer. Only the core entity store and
 * core services touch this; transport and domain modules go through services.
 *
 * SQLite locally (config.databaseUrl is a file path); a Postgres adapter would
 * slot in behind this same module for deployment.
 */
// Tests run against an in-memory database so they never touch the dev file.
const dbPath = process.env.NODE_ENV === 'test' ? ':memory:' : config.databaseUrl;
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      facility_code TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT 'General',
      roles TEXT NOT NULL,            -- JSON array of roles
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS facilities (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      phone TEXT,
      departments TEXT NOT NULL,      -- JSON array of department names
      specialties TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      roles TEXT NOT NULL,            -- JSON array of roles
      department TEXT NOT NULL,
      facility_code TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,           -- 'pending' | 'used' | 'expired'
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,             -- encrypted at rest
      phone TEXT,                     -- encrypted at rest
      national_id TEXT,               -- encrypted at rest
      address TEXT,                   -- encrypted at rest
      blood_type TEXT,
      allergies TEXT,                 -- encrypted at rest
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queue_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      facility_code TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT 'General',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      doctor_id INTEGER NOT NULL REFERENCES staff_users(id),
      queue_entry_id INTEGER REFERENCES queue_entries(id),
      facility_code TEXT NOT NULL,
      access_code TEXT NOT NULL UNIQUE,
      diagnosis TEXT,
      notes TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lab_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NOT NULL REFERENCES visits(id),
      test_name TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'Medium',
      status TEXT NOT NULL DEFAULT 'Pending',
      notes TEXT,
      result TEXT,
      result_attachment_id INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_type TEXT NOT NULL,       -- 'visit'
      visit_id INTEGER NOT NULL REFERENCES visits(id),
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploaded_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS otps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context TEXT NOT NULL,          -- e.g. 'portal:<patientId>'
      target_email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prescriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NOT NULL REFERENCES visits(id),
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      medications TEXT NOT NULL,      -- JSON array
      is_active_plan INTEGER NOT NULL DEFAULT 1,
      pharmacy_lookup_token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dispensing_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prescription_id INTEGER NOT NULL REFERENCES prescriptions(id),
      pharmacy_code TEXT NOT NULL,
      items_dispensed TEXT NOT NULL,
      dispensed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS access_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      granted_to_doctor_id INTEGER NOT NULL REFERENCES staff_users(id),
      granted_by TEXT NOT NULL,       -- 'patient' | 'peerDoctor'
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER,
      actor_role TEXT,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id INTEGER,
      detail TEXT,
      at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template TEXT NOT NULL,
      to_email TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

export function nowUtc(): string {
  return new Date().toISOString();
}

export function todayUtcDatePrefix(): string {
  // YYYY-MM-DD in UTC, for scoping "today" queries.
  return new Date().toISOString().slice(0, 10);
}
