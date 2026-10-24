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
      bed_id INTEGER REFERENCES beds(id),
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

    -- Hospital beds. Status drives the receptionist "seat-map" availability view.
    CREATE TABLE IF NOT EXISTS beds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      facility_code TEXT NOT NULL,
      ward TEXT NOT NULL,             -- e.g. 'Regular' | 'Emergency'
      room TEXT NOT NULL,             -- room label, e.g. 'R-101'
      label TEXT NOT NULL,            -- bed label within the room, e.g. 'A'
      status TEXT NOT NULL DEFAULT 'Available', -- 'Available'|'Occupied'|'Reserved'|'Cleaning'|'OutOfService'
      updated_at TEXT NOT NULL
    );

    -- Categorized EHR entries. Category drives technician specialty scoping.
    CREATE TABLE IF NOT EXISTS ehr_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      visit_id INTEGER REFERENCES visits(id),
      facility_code TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,          -- encrypted at rest
      author_id INTEGER REFERENCES staff_users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS technician_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      technician_id INTEGER NOT NULL REFERENCES staff_users(id),
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      assigned_by INTEGER NOT NULL REFERENCES staff_users(id),
      created_at TEXT NOT NULL,
      UNIQUE (technician_id, patient_id)
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      doctor_id INTEGER NOT NULL REFERENCES staff_users(id),
      facility_code TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,     -- UTC ISO timestamp
      reason TEXT,
      status TEXT NOT NULL,           -- 'Scheduled' | 'Cancelled' | 'Completed'
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pharmacy_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pharmacy_code TEXT NOT NULL,
      medication_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      supplier TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (pharmacy_code, medication_name)
    );

    -- Published estimated costs per facility service / condition.
    CREATE TABLE IF NOT EXISTS service_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      facility_code TEXT NOT NULL,
      service_name TEXT NOT NULL,
      condition TEXT,
      estimated_cents INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS insurance_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      monthly_premium_cents INTEGER NOT NULL,
      coverage_percent INTEGER NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS patient_insurance (
      patient_id INTEGER PRIMARY KEY REFERENCES patients(id),
      plan_id INTEGER NOT NULL REFERENCES insurance_plans(id),
      member_id TEXT,                 -- encrypted at rest
      start_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      facility_code TEXT NOT NULL,    -- the billing facility (hospital or pharmacy)
      source TEXT NOT NULL,           -- 'Visit' | 'Pharmacy'
      source_id INTEGER,
      description TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      insurance_cents INTEGER NOT NULL,
      patient_cents INTEGER NOT NULL,
      referring_facility_code TEXT,   -- hospital that issued the prescription
      status TEXT NOT NULL,           -- 'Outstanding' | 'Paid'
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS patient_accommodations (
      patient_id INTEGER PRIMARY KEY REFERENCES patients(id),
      needs TEXT NOT NULL,            -- JSON array of accommodation names
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS facility_accommodations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      facility_code TEXT NOT NULL,
      accommodation TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      in_use INTEGER NOT NULL DEFAULT 0,
      UNIQUE (facility_code, accommodation)
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      facility_code TEXT NOT NULL,
      name TEXT NOT NULL,
      room_type TEXT NOT NULL,
      status TEXT NOT NULL,           -- 'Available' | 'Occupied' | 'Cleaning' | 'Maintenance'
      updated_at TEXT NOT NULL
    );

    -- Unified equipment inventory (superset of both merged feature sets):
    --   category + location  -> facility-ops / technician UI
    --   room                 -> receptionist availability seat-map
    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      facility_code TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General', -- EHR category, or 'General'
      location TEXT,
      room TEXT,                      -- room it currently lives in (seat-map)
      status TEXT NOT NULL DEFAULT 'Operational', -- Operational|InUse|Maintenance|OutOfService|Broken
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL REFERENCES staff_users(id),
      facility_code TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,   -- 0 = Sunday (UTC)
      start_time TEXT NOT NULL,       -- 'HH:MM' UTC
      end_time TEXT NOT NULL
    );
  `);

  runMigrations();
}

/**
 * Lightweight, idempotent migrations for databases created by earlier builds.
 * CREATE TABLE IF NOT EXISTS never alters an existing table, so new columns on
 * existing tables are added here. Each step checks first and is safe to run on
 * every startup.
 */
function runMigrations(): void {
  // Receptionist bed-occupancy link.
  ensureColumn('visits', 'bed_id', 'INTEGER REFERENCES beds(id)');
  // Facility-ops / identity additions.
  ensureColumn('facilities', 'kind', "TEXT NOT NULL DEFAULT 'Hospital'");
  ensureColumn('facilities', 'operating_hours', 'TEXT');
  ensureColumn('staff_users', 'specialty', 'TEXT');
  ensureColumn('staff_users', 'license_number', 'TEXT');
  ensureColumn('staff_invites', 'specialty', 'TEXT');
  ensureColumn('dispensing_records', 'patient_id', 'INTEGER');
  // Unified equipment: make sure ALL superset columns exist regardless of which
  // side's older equipment table a database was created with.
  ensureColumn('equipment', 'category', "TEXT NOT NULL DEFAULT 'General'");
  ensureColumn('equipment', 'location', 'TEXT');
  ensureColumn('equipment', 'room', 'TEXT');
}

/** Add a column to an existing table if it is missing (idempotent). */
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function nowUtc(): string {
  return new Date().toISOString();
}

export function todayUtcDatePrefix(): string {
  // YYYY-MM-DD in UTC, for scoping "today" queries.
  return new Date().toISOString().slice(0, 10);
}
