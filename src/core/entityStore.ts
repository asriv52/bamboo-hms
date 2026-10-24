import { db, nowUtc } from './db';
import { decryptPII, encryptPII, hashPassword } from './crypto';
import {
  Facility,
  Medication,
  Patient,
  Prescription,
  QueueEntry,
  QueueStatus,
  Role,
  StaffInvite,
  StaffUser,
  Visit,
  VisitStatus,
} from './types';

/**
 * The single data-access boundary for the core layer. No transport or domain
 * module touches `db` directly — they call these functions (via core services).
 * PII columns are encrypted on the way in and decrypted on the way out here.
 */

// ---- Staff users ----------------------------------------------------------

function rowToStaff(row: any): StaffUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    facilityCode: row.facility_code,
    department: row.department,
    roles: JSON.parse(row.roles) as Role[],
    createdAt: row.created_at,
  };
}

export function createStaffUser(input: {
  email: string;
  password: string;
  name: string;
  phone: string | null;
  facilityCode: string;
  department?: string;
  roles: Role[];
}): StaffUser {
  const info = db
    .prepare(
      `INSERT INTO staff_users (email, password, name, phone, facility_code, department, roles, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.email,
      hashPassword(input.password),
      input.name,
      input.phone,
      input.facilityCode,
      input.department ?? 'General',
      JSON.stringify(input.roles),
      nowUtc()
    );
  return getStaffById(Number(info.lastInsertRowid))!;
}

export function listStaffByFacility(facilityCode: string): StaffUser[] {
  const rows = db
    .prepare('SELECT * FROM staff_users WHERE facility_code = ? ORDER BY id ASC')
    .all(facilityCode);
  return rows.map(rowToStaff);
}

export function updateStaffRolesAndDepartment(
  id: number,
  roles: Role[],
  department: string
): void {
  db.prepare('UPDATE staff_users SET roles = ?, department = ? WHERE id = ?').run(
    JSON.stringify(roles),
    department,
    id
  );
}

export function getStaffById(id: number): StaffUser | null {
  const row = db.prepare('SELECT * FROM staff_users WHERE id = ?').get(id);
  return row ? rowToStaff(row) : null;
}

export function getStaffByEmail(email: string): StaffUser | null {
  const row = db.prepare('SELECT * FROM staff_users WHERE email = ?').get(email);
  return row ? rowToStaff(row) : null;
}

export function getStaffPasswordHash(id: number): string | null {
  const row = db.prepare('SELECT password FROM staff_users WHERE id = ?').get(id) as any;
  return row ? row.password : null;
}

// ---- Patients -------------------------------------------------------------

function rowToPatient(row: any): Patient {
  return {
    id: row.id,
    email: row.email,
    name: decryptPII(row.name) ?? '',
    phone: decryptPII(row.phone),
    nationalId: decryptPII(row.national_id),
    address: decryptPII(row.address),
    bloodType: row.blood_type,
    allergies: decryptPII(row.allergies),
    createdAt: row.created_at,
  };
}

export function createPatient(input: {
  email: string;
  name: string;
  phone: string | null;
  nationalId: string | null;
  address: string | null;
  bloodType: string | null;
  allergies: string | null;
}): Patient {
  const info = db
    .prepare(
      `INSERT INTO patients (email, name, phone, national_id, address, blood_type, allergies, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.email,
      encryptPII(input.name),
      encryptPII(input.phone),
      encryptPII(input.nationalId),
      encryptPII(input.address),
      input.bloodType,
      encryptPII(input.allergies),
      nowUtc()
    );
  return getPatientById(Number(info.lastInsertRowid))!;
}

export function getPatientById(id: number): Patient | null {
  const row = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  return row ? rowToPatient(row) : null;
}

export function getPatientByEmail(email: string): Patient | null {
  const row = db.prepare('SELECT * FROM patients WHERE email = ?').get(email);
  return row ? rowToPatient(row) : null;
}

/**
 * Search is done in-memory because name is encrypted at rest and cannot be
 * matched with a SQL LIKE. For a single-clinic demo the dataset is tiny; a
 * production build would use a searchable hashed index.
 */
export function searchPatients(query: string): Patient[] {
  const q = query.trim().toLowerCase();
  const all = db.prepare('SELECT * FROM patients ORDER BY id DESC').all();
  return all
    .map(rowToPatient)
    .filter(
      (p) =>
        String(p.id) === q ||
        p.name.toLowerCase().includes(q) ||
        p.email.includes(q)
    );
}

export function countPatientsRegisteredToday(datePrefix: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM patients WHERE substr(created_at, 1, 10) = ?`
    )
    .get(datePrefix) as any;
  return row.c;
}

// ---- Queue ----------------------------------------------------------------

function rowToQueue(row: any): QueueEntry {
  return {
    id: row.id,
    patientId: row.patient_id,
    facilityCode: row.facility_code,
    department: row.department,
    status: row.status as QueueStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createQueueEntry(
  patientId: number,
  facilityCode: string,
  department: string
): QueueEntry {
  const ts = nowUtc();
  const info = db
    .prepare(
      `INSERT INTO queue_entries (patient_id, facility_code, department, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Waiting', ?, ?)`
    )
    .run(patientId, facilityCode, department, ts, ts);
  return getQueueEntry(Number(info.lastInsertRowid))!;
}

export function getQueueEntry(id: number): QueueEntry | null {
  const row = db.prepare('SELECT * FROM queue_entries WHERE id = ?').get(id);
  return row ? rowToQueue(row) : null;
}

export function updateQueueStatus(id: number, status: QueueStatus): void {
  db.prepare('UPDATE queue_entries SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    nowUtc(),
    id
  );
}

export function listTodayQueue(facilityCode: string, datePrefix: string): QueueEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM queue_entries
       WHERE facility_code = ? AND substr(created_at, 1, 10) = ?
       ORDER BY created_at ASC`
    )
    .all(facilityCode, datePrefix);
  return rows.map(rowToQueue);
}

export function countQueueToday(
  facilityCode: string,
  datePrefix: string,
  status?: QueueStatus
): number {
  const base = `SELECT COUNT(*) as c FROM queue_entries
                WHERE facility_code = ? AND substr(created_at, 1, 10) = ?`;
  const row = status
    ? (db.prepare(base + ' AND status = ?').get(facilityCode, datePrefix, status) as any)
    : (db.prepare(base).get(facilityCode, datePrefix) as any);
  return row.c;
}

/** Per-department waiting count for today. Returns { department: count }. */
export function countQueueTodayByDepartment(
  facilityCode: string,
  datePrefix: string,
  status: QueueStatus
): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT department, COUNT(*) as c FROM queue_entries
       WHERE facility_code = ? AND substr(created_at, 1, 10) = ? AND status = ?
       GROUP BY department`
    )
    .all(facilityCode, datePrefix, status) as any[];
  return Object.fromEntries(rows.map((r) => [r.department, r.c]));
}

/**
 * Per-department count of patients registered today, attributed to the
 * department(s) they were queued into today. Patients never queued show under
 * "Unassigned".
 */
export function countRegisteredTodayByDepartment(
  facilityCode: string,
  datePrefix: string
): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT COALESCE(q.department, 'Unassigned') as department, COUNT(DISTINCT p.id) as c
       FROM patients p
       LEFT JOIN queue_entries q
         ON q.patient_id = p.id AND q.facility_code = ? AND substr(q.created_at,1,10) = ?
       WHERE substr(p.created_at, 1, 10) = ?
       GROUP BY COALESCE(q.department, 'Unassigned')`
    )
    .all(facilityCode, datePrefix, datePrefix) as any[];
  return Object.fromEntries(rows.map((r) => [r.department, r.c]));
}

// ---- Visits ---------------------------------------------------------------

function rowToVisit(row: any): Visit {
  return {
    id: row.id,
    patientId: row.patient_id,
    doctorId: row.doctor_id,
    queueEntryId: row.queue_entry_id,
    facilityCode: row.facility_code,
    diagnosis: row.diagnosis,
    notes: row.notes,
    status: row.status as VisitStatus,
    createdAt: row.created_at,
  };
}

export function createVisit(input: {
  patientId: number;
  doctorId: number;
  queueEntryId: number | null;
  facilityCode: string;
}): Visit {
  const info = db
    .prepare(
      `INSERT INTO visits (patient_id, doctor_id, queue_entry_id, facility_code, status, created_at)
       VALUES (?, ?, ?, ?, 'Open', ?)`
    )
    .run(
      input.patientId,
      input.doctorId,
      input.queueEntryId,
      input.facilityCode,
      nowUtc()
    );
  return getVisit(Number(info.lastInsertRowid))!;
}

export function getVisit(id: number): Visit | null {
  const row = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
  return row ? rowToVisit(row) : null;
}

export function finalizeVisit(id: number, diagnosis: string, notes: string): void {
  db.prepare(
    `UPDATE visits SET diagnosis = ?, notes = ?, status = 'Finalized' WHERE id = ?`
  ).run(diagnosis, notes, id);
}

export function listVisitsForPatient(patientId: number): Visit[] {
  const rows = db
    .prepare('SELECT * FROM visits WHERE patient_id = ? ORDER BY created_at DESC')
    .all(patientId);
  return rows.map(rowToVisit);
}

export function doctorHasVisitWithPatient(doctorId: number, patientId: number): boolean {
  const row = db
    .prepare('SELECT 1 FROM visits WHERE doctor_id = ? AND patient_id = ? LIMIT 1')
    .get(doctorId, patientId);
  return !!row;
}

export function countVisitsFinalizedToday(
  facilityCode: string,
  datePrefix: string
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM visits
       WHERE facility_code = ? AND status = 'Finalized'
       AND substr(created_at, 1, 10) = ?`
    )
    .get(facilityCode, datePrefix) as any;
  return row.c;
}

/** Per-department finalized-visit count today, attributed to the doctor's department. */
export function countVisitsFinalizedTodayByDepartment(
  facilityCode: string,
  datePrefix: string
): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT COALESCE(s.department, 'Unassigned') as department, COUNT(*) as c
       FROM visits v JOIN staff_users s ON s.id = v.doctor_id
       WHERE v.facility_code = ? AND v.status = 'Finalized'
       AND substr(v.created_at, 1, 10) = ?
       GROUP BY COALESCE(s.department, 'Unassigned')`
    )
    .all(facilityCode, datePrefix) as any[];
  return Object.fromEntries(rows.map((r) => [r.department, r.c]));
}

// ---- Prescriptions --------------------------------------------------------

function rowToPrescription(row: any): Prescription {
  return {
    id: row.id,
    visitId: row.visit_id,
    patientId: row.patient_id,
    medications: JSON.parse(row.medications) as Medication[],
    isActivePlan: !!row.is_active_plan,
    pharmacyLookupToken: row.pharmacy_lookup_token,
    createdAt: row.created_at,
  };
}

export function createPrescription(input: {
  visitId: number;
  patientId: number;
  medications: Medication[];
  pharmacyLookupToken: string;
}): Prescription {
  // Only one active plan per patient: deactivate older ones.
  db.prepare('UPDATE prescriptions SET is_active_plan = 0 WHERE patient_id = ?').run(
    input.patientId
  );
  const info = db
    .prepare(
      `INSERT INTO prescriptions (visit_id, patient_id, medications, is_active_plan, pharmacy_lookup_token, created_at)
       VALUES (?, ?, ?, 1, ?, ?)`
    )
    .run(
      input.visitId,
      input.patientId,
      JSON.stringify(input.medications),
      input.pharmacyLookupToken,
      nowUtc()
    );
  return getPrescription(Number(info.lastInsertRowid))!;
}

export function getPrescription(id: number): Prescription | null {
  const row = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(id);
  return row ? rowToPrescription(row) : null;
}

export function getActivePrescriptionForPatient(patientId: number): Prescription | null {
  const row = db
    .prepare(
      'SELECT * FROM prescriptions WHERE patient_id = ? AND is_active_plan = 1 ORDER BY id DESC LIMIT 1'
    )
    .get(patientId);
  return row ? rowToPrescription(row) : null;
}

export function getPrescriptionByToken(token: string): Prescription | null {
  const row = db
    .prepare('SELECT * FROM prescriptions WHERE pharmacy_lookup_token = ?')
    .get(token);
  return row ? rowToPrescription(row) : null;
}

export function createDispensingRecord(input: {
  prescriptionId: number;
  pharmacyCode: string;
  itemsDispensed: string;
}): void {
  db.prepare(
    `INSERT INTO dispensing_records (prescription_id, pharmacy_code, items_dispensed, dispensed_at)
     VALUES (?, ?, ?, ?)`
  ).run(input.prescriptionId, input.pharmacyCode, input.itemsDispensed, nowUtc());
}

// ---- Access grants --------------------------------------------------------

export function hasActiveGrant(doctorId: number, patientId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM access_grants
       WHERE granted_to_doctor_id = ? AND patient_id = ?
       AND revoked_at IS NULL AND expires_at > ?
       LIMIT 1`
    )
    .get(doctorId, patientId, nowUtc());
  return !!row;
}

// ---- Facilities -----------------------------------------------------------

function rowToFacility(row: any): Facility {
  return {
    code: row.code,
    name: row.name,
    address: row.address,
    phone: row.phone,
    departments: JSON.parse(row.departments) as string[],
    specialties: row.specialties,
    updatedAt: row.updated_at,
  };
}

export function upsertFacility(input: {
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  departments: string[];
  specialties: string | null;
}): Facility {
  db.prepare(
    `INSERT INTO facilities (code, name, address, phone, departments, specialties, updated_at)
     VALUES (@code, @name, @address, @phone, @departments, @specialties, @updatedAt)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name, address = excluded.address, phone = excluded.phone,
       departments = excluded.departments, specialties = excluded.specialties,
       updated_at = excluded.updated_at`
  ).run({
    code: input.code,
    name: input.name,
    address: input.address,
    phone: input.phone,
    departments: JSON.stringify(input.departments),
    specialties: input.specialties,
    updatedAt: nowUtc(),
  });
  return getFacility(input.code)!;
}

export function getFacility(code: string): Facility | null {
  const row = db.prepare('SELECT * FROM facilities WHERE code = ?').get(code);
  return row ? rowToFacility(row) : null;
}

// ---- Staff invites --------------------------------------------------------

function rowToInvite(row: any): StaffInvite {
  return {
    id: row.id,
    email: row.email,
    roles: JSON.parse(row.roles) as Role[],
    department: row.department,
    facilityCode: row.facility_code,
    token: row.token,
    status: row.status,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

export function createInvite(input: {
  email: string;
  roles: Role[];
  department: string;
  facilityCode: string;
  token: string;
  expiresAt: string;
}): StaffInvite {
  const info = db
    .prepare(
      `INSERT INTO staff_invites (email, roles, department, facility_code, token, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(
      input.email,
      JSON.stringify(input.roles),
      input.department,
      input.facilityCode,
      input.token,
      input.expiresAt,
      nowUtc()
    );
  const row = db
    .prepare('SELECT * FROM staff_invites WHERE id = ?')
    .get(Number(info.lastInsertRowid));
  return rowToInvite(row);
}

export function getInviteByToken(token: string): StaffInvite | null {
  const row = db.prepare('SELECT * FROM staff_invites WHERE token = ?').get(token);
  return row ? rowToInvite(row) : null;
}

export function markInviteUsed(id: number): void {
  db.prepare("UPDATE staff_invites SET status = 'used', used_at = ? WHERE id = ?").run(
    nowUtc(),
    id
  );
}

export function listInvitesByFacility(facilityCode: string): StaffInvite[] {
  const rows = db
    .prepare('SELECT * FROM staff_invites WHERE facility_code = ? ORDER BY id DESC')
    .all(facilityCode);
  return rows.map(rowToInvite);
}
