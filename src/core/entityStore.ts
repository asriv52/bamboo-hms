import { db, nowUtc } from './db';
import { decryptPII, encryptPII, hashPassword, shortCode } from './crypto';
import {
  AccessGrant,
  Attachment,
  Bed,
  BedStatus,
  DispensingRecord,
  EhrCategory,
<<<<<<< HEAD
  Equipment,
  EquipmentStatus,
=======
>>>>>>> 6b4b480bf12e8c89762319e0e9401ba026d26828
  Facility,
  FacilityKind,
  LabTest,
  LabTestPriority,
  LabTestStatus,
  Medication,
  Otp,
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
    specialty: (row.specialty ?? null) as EhrCategory | null,
    licenseNumber: row.license_number ?? null,
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
  specialty?: EhrCategory | null;
  licenseNumber?: string | null;
}): StaffUser {
  const info = db
    .prepare(
      `INSERT INTO staff_users (email, password, name, phone, facility_code, department, roles, specialty, license_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.email,
      hashPassword(input.password),
      input.name,
      input.phone,
      input.facilityCode,
      input.department ?? 'General',
      JSON.stringify(input.roles),
      input.specialty ?? null,
      input.licenseNumber ?? null,
      nowUtc()
    );
  return getStaffById(Number(info.lastInsertRowid))!;
}

export function updateStaffSpecialty(id: number, specialty: EhrCategory | null): void {
  db.prepare('UPDATE staff_users SET specialty = ? WHERE id = ?').run(specialty, id);
}

/** Doctors across all facilities (public directory: name + facility only). */
export function listStaffWithRole(role: Role): StaffUser[] {
  return (db.prepare('SELECT * FROM staff_users ORDER BY name ASC').all() as any[])
    .map(rowToStaff)
    .filter((s) => s.roles.includes(role));
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

/** All patients, newest first. Small single-clinic dataset. */
export function listPatients(): Patient[] {
  const rows = db.prepare('SELECT * FROM patients ORDER BY id DESC').all();
  return rows.map(rowToPatient);
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
    bedId: row.bed_id ?? null,
    facilityCode: row.facility_code,
    accessCode: row.access_code,
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
  bedId?: number | null;
}): Visit {
  // Generate a unique short access code. Collisions are astronomically unlikely
  // but we retry a few times to be safe.
  let accessCode = shortCode();
  for (let i = 0; i < 5 && getVisitByAccessCode(accessCode); i++) {
    accessCode = shortCode();
  }
  const info = db
    .prepare(
      `INSERT INTO visits (patient_id, doctor_id, queue_entry_id, bed_id, facility_code, access_code, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Open', ?)`
    )
    .run(
      input.patientId,
      input.doctorId,
      input.queueEntryId,
      input.bedId ?? null,
      input.facilityCode,
      accessCode,
      nowUtc()
    );
  return getVisit(Number(info.lastInsertRowid))!;
}

/**
 * Occupancy for every currently-OPEN visit at a facility that is assigned to a
 * bed. Returns bed id + patient/doctor names only (location/assignment data —
 * no clinical content). Patient names are decrypted; staff names are plaintext.
 */
export function listBedOccupancyByFacility(facilityCode: string): {
  bedId: number;
  visitId: number;
  patientName: string;
  doctorName: string;
}[] {
  const rows = db
    .prepare(
      `SELECT v.id as visit_id, v.bed_id as bed_id, v.patient_id as patient_id, s.name as doctor_name
       FROM visits v
       JOIN staff_users s ON s.id = v.doctor_id
       WHERE v.facility_code = ? AND v.status = 'Open' AND v.bed_id IS NOT NULL`
    )
    .all(facilityCode) as any[];
  return rows.map((r) => {
    const patient = getPatientById(r.patient_id);
    return {
      bedId: r.bed_id as number,
      visitId: r.visit_id as number,
      patientName: patient ? patient.name : '(unknown)',
      doctorName: (r.doctor_name as string) ?? '(unknown)',
    };
  });
}

/** The open visit currently occupying a bed at a facility, or null. */
export function getOpenVisitByBed(facilityCode: string, bedId: number): Visit | null {
  const row = db
    .prepare(
      `SELECT * FROM visits
       WHERE facility_code = ? AND bed_id = ? AND status = 'Open'
       ORDER BY id DESC LIMIT 1`
    )
    .get(facilityCode, bedId);
  return row ? rowToVisit(row) : null;
}

/**
 * Detach any open visit from a bed at this facility (frees the bed). The visit
 * itself — and the patient — remain in the database; only the bed link clears.
 * Returns the number of visits detached.
 */
export function clearBedOccupancy(facilityCode: string, bedId: number): number {
  const info = db
    .prepare(
      `UPDATE visits SET bed_id = NULL
       WHERE facility_code = ? AND bed_id = ? AND status = 'Open'`
    )
    .run(facilityCode, bedId);
  return info.changes;
}

export function getVisit(id: number): Visit | null {
  const row = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
  return row ? rowToVisit(row) : null;
}

export function getVisitByAccessCode(code: string): Visit | null {
  const row = db
    .prepare('SELECT * FROM visits WHERE access_code = ?')
    .get(code.trim().toUpperCase());
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

export function listVisitsForQueueEntry(queueEntryId: number): Visit[] {
  return (db.prepare('SELECT * FROM visits WHERE queue_entry_id = ?').all(queueEntryId) as any[]).map(
    rowToVisit
  );
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

export function listPrescriptionsForPatient(patientId: number): Prescription[] {
  const rows = db
    .prepare('SELECT * FROM prescriptions WHERE patient_id = ? ORDER BY id DESC')
    .all(patientId);
  return rows.map(rowToPrescription);
}

export function createDispensingRecord(input: {
  prescriptionId: number;
  patientId: number | null;
  pharmacyCode: string;
  itemsDispensed: string;
}): number {
  const info = db
    .prepare(
      `INSERT INTO dispensing_records (prescription_id, patient_id, pharmacy_code, items_dispensed, dispensed_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      input.prescriptionId,
      input.patientId,
      input.pharmacyCode,
      input.itemsDispensed,
      nowUtc()
    );
  return Number(info.lastInsertRowid);
}

function rowToDispensing(row: any): DispensingRecord {
  return {
    id: row.id,
    prescriptionId: row.prescription_id,
    patientId: row.patient_id ?? null,
    pharmacyCode: row.pharmacy_code,
    itemsDispensed: row.items_dispensed,
    dispensedAt: row.dispensed_at,
  };
}

export function listDispensingByPharmacy(pharmacyCode: string): DispensingRecord[] {
  return (
    db
      .prepare('SELECT * FROM dispensing_records WHERE pharmacy_code = ? ORDER BY id DESC')
      .all(pharmacyCode) as any[]
  ).map(rowToDispensing);
}

export function pharmacyHasDispensedTo(pharmacyCode: string, patientId: number): boolean {
  return !!db
    .prepare('SELECT 1 FROM dispensing_records WHERE pharmacy_code = ? AND patient_id = ? LIMIT 1')
    .get(pharmacyCode, patientId);
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

function rowToGrant(row: any): AccessGrant {
  return {
    id: row.id,
    patientId: row.patient_id,
    grantedToDoctorId: row.granted_to_doctor_id,
    grantedBy: row.granted_by,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export function createGrant(input: {
  patientId: number;
  doctorId: number;
  grantedBy: 'patient' | 'peerDoctor';
  expiresAt: string;
}): AccessGrant {
  const info = db
    .prepare(
      `INSERT INTO access_grants (patient_id, granted_to_doctor_id, granted_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(input.patientId, input.doctorId, input.grantedBy, input.expiresAt, nowUtc());
  return getGrant(Number(info.lastInsertRowid))!;
}

export function getGrant(id: number): AccessGrant | null {
  const row = db.prepare('SELECT * FROM access_grants WHERE id = ?').get(id);
  return row ? rowToGrant(row) : null;
}

export function listGrantsForPatient(patientId: number): AccessGrant[] {
  return (
    db
      .prepare('SELECT * FROM access_grants WHERE patient_id = ? ORDER BY id DESC')
      .all(patientId) as any[]
  ).map(rowToGrant);
}

/** Grants issued to doctors at a facility (for admin consent records). */
export function listGrantsForFacility(facilityCode: string): AccessGrant[] {
  return (
    db
      .prepare(
        `SELECT g.* FROM access_grants g JOIN staff_users s ON s.id = g.granted_to_doctor_id
         WHERE s.facility_code = ? ORDER BY g.id DESC`
      )
      .all(facilityCode) as any[]
  ).map(rowToGrant);
}

export function revokeGrant(id: number): void {
  db.prepare('UPDATE access_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
    nowUtc(),
    id
  );
}

// ---- Facilities -----------------------------------------------------------

function rowToFacility(row: any): Facility {
  return {
    code: row.code,
    name: row.name,
    kind: (row.kind ?? 'Hospital') as FacilityKind,
    address: row.address,
    phone: row.phone,
    operatingHours: row.operating_hours ?? null,
    departments: JSON.parse(row.departments) as string[],
    specialties: row.specialties,
    updatedAt: row.updated_at,
  };
}

/**
 * Insert or update a facility. `kind` and `operatingHours` are optional on
 * update: when omitted, the existing values are kept.
 */
export function upsertFacility(input: {
  code: string;
  name: string;
  kind?: FacilityKind;
  address: string | null;
  phone: string | null;
  operatingHours?: string | null;
  departments: string[];
  specialties: string | null;
}): Facility {
  const existing = getFacility(input.code);
  db.prepare(
    `INSERT INTO facilities (code, name, kind, address, phone, operating_hours, departments, specialties, updated_at)
     VALUES (@code, @name, @kind, @address, @phone, @operatingHours, @departments, @specialties, @updatedAt)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name, kind = excluded.kind, address = excluded.address,
       phone = excluded.phone, operating_hours = excluded.operating_hours,
       departments = excluded.departments, specialties = excluded.specialties,
       updated_at = excluded.updated_at`
  ).run({
    code: input.code,
    name: input.name,
    kind: input.kind ?? existing?.kind ?? 'Hospital',
    address: input.address,
    phone: input.phone,
    operatingHours:
      input.operatingHours !== undefined ? input.operatingHours : existing?.operatingHours ?? null,
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

// ---- Beds -----------------------------------------------------------------
<<<<<<< HEAD
=======
// (Equipment lives in opsStore; the receptionist seat-map reads it from there.)
>>>>>>> 6b4b480bf12e8c89762319e0e9401ba026d26828

function rowToBed(row: any): Bed {
  return {
    id: row.id,
    facilityCode: row.facility_code,
    ward: row.ward,
    room: row.room,
    label: row.label,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

/** All beds for a facility, ordered for a stable grid layout. */
export function listBedsByFacility(facilityCode: string): Bed[] {
  const rows = db
    .prepare(
      `SELECT * FROM beds WHERE facility_code = ?
       ORDER BY ward ASC, room ASC, label ASC`
    )
    .all(facilityCode);
  return rows.map(rowToBed);
}

export function getBed(id: number): Bed | null {
  const row = db.prepare('SELECT * FROM beds WHERE id = ?').get(id);
  return row ? rowToBed(row) : null;
}

export function createBed(input: {
  facilityCode: string;
  ward: string;
  room: string;
  label: string;
  status?: BedStatus;
}): Bed {
  const info = db
    .prepare(
      `INSERT INTO beds (facility_code, ward, room, label, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.facilityCode,
      input.ward,
      input.room,
      input.label,
      input.status ?? 'Available',
      nowUtc()
    );
  return getBed(Number(info.lastInsertRowid))!;
}

/** Update a bed's status, scoped to the owning facility (no cross-facility writes). */
export function updateBedStatus(
  facilityCode: string,
  id: number,
  status: BedStatus
): Bed | null {
  db.prepare(
    `UPDATE beds SET status = ?, updated_at = ? WHERE id = ? AND facility_code = ?`
  ).run(status, nowUtc(), id, facilityCode);
  const bed = getBed(id);
  return bed && bed.facilityCode === facilityCode ? bed : null;
}

<<<<<<< HEAD
// ---- Equipment ------------------------------------------------------------

// Equipment on the UNIFIED schema. These accessors serve the receptionist
// seat-map (room-based). The facility-ops UI uses its own accessors in
// opsStore against the same table; both read the superset columns.

function rowToEquipment(row: any): Equipment {
  return {
    id: row.id,
    facilityCode: row.facility_code,
    name: row.name,
    category: row.category ?? 'General',
    location: row.location ?? null,
    room: row.room ?? null,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export function listEquipmentByFacility(facilityCode: string): Equipment[] {
  const rows = db
    .prepare(
      `SELECT * FROM equipment WHERE facility_code = ?
       ORDER BY COALESCE(room, location, '') ASC, name ASC`
    )
    .all(facilityCode);
  return rows.map(rowToEquipment);
}

export function getEquipment(id: number): Equipment | null {
  const row = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
  return row ? rowToEquipment(row) : null;
}

export function createEquipment(input: {
  facilityCode: string;
  name: string;
  room?: string | null;
  category?: string;
  location?: string | null;
  status?: EquipmentStatus;
}): Equipment {
  const info = db
    .prepare(
      `INSERT INTO equipment (facility_code, name, category, location, room, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.facilityCode,
      input.name,
      input.category ?? 'General',
      input.location ?? null,
      input.room ?? null,
      input.status ?? 'Operational',
      nowUtc()
    );
  return getEquipment(Number(info.lastInsertRowid))!;
}

export function updateEquipmentStatus(
  facilityCode: string,
  id: number,
  status: EquipmentStatus
): Equipment | null {
  db.prepare(
    `UPDATE equipment SET status = ?, updated_at = ? WHERE id = ? AND facility_code = ?`
  ).run(status, nowUtc(), id, facilityCode);
  const eq = getEquipment(id);
  return eq && eq.facilityCode === facilityCode ? eq : null;
}

=======
>>>>>>> 6b4b480bf12e8c89762319e0e9401ba026d26828
export function listFacilities(kind?: FacilityKind): Facility[] {
  const rows = kind
    ? db.prepare('SELECT * FROM facilities WHERE kind = ? ORDER BY name ASC').all(kind)
    : db.prepare('SELECT * FROM facilities ORDER BY name ASC').all();
  return (rows as any[]).map(rowToFacility);
}

// ---- Staff invites --------------------------------------------------------

function rowToInvite(row: any): StaffInvite {
  return {
    id: row.id,
    email: row.email,
    roles: JSON.parse(row.roles) as Role[],
    department: row.department,
    specialty: (row.specialty ?? null) as EhrCategory | null,
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
  specialty?: EhrCategory | null;
  facilityCode: string;
  token: string;
  expiresAt: string;
}): StaffInvite {
  const info = db
    .prepare(
      `INSERT INTO staff_invites (email, roles, department, specialty, facility_code, token, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(
      input.email,
      JSON.stringify(input.roles),
      input.department,
      input.specialty ?? null,
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

// ---- Lab tests ------------------------------------------------------------

function rowToLabTest(row: any): LabTest {
  return {
    id: row.id,
    visitId: row.visit_id,
    testName: row.test_name,
    priority: row.priority as LabTestPriority,
    status: row.status as LabTestStatus,
    notes: row.notes,
    result: row.result,
    resultAttachmentId: row.result_attachment_id,
    createdAt: row.created_at,
  };
}

export function createLabTest(input: {
  visitId: number;
  testName: string;
  priority: LabTestPriority;
  notes: string | null;
}): LabTest {
  const info = db
    .prepare(
      `INSERT INTO lab_tests (visit_id, test_name, priority, status, notes, created_at)
       VALUES (?, ?, ?, 'Pending', ?, ?)`
    )
    .run(input.visitId, input.testName, input.priority, input.notes, nowUtc());
  return getLabTest(Number(info.lastInsertRowid))!;
}

export function getLabTest(id: number): LabTest | null {
  const row = db.prepare('SELECT * FROM lab_tests WHERE id = ?').get(id);
  return row ? rowToLabTest(row) : null;
}

export function listLabTestsForVisit(visitId: number): LabTest[] {
  const rows = db
    .prepare('SELECT * FROM lab_tests WHERE visit_id = ? ORDER BY id ASC')
    .all(visitId);
  return rows.map(rowToLabTest);
}

export function recordLabTestResult(
  id: number,
  result: string,
  resultAttachmentId: number | null
): void {
  db.prepare(
    `UPDATE lab_tests SET status = 'Done', result = ?, result_attachment_id = ? WHERE id = ?`
  ).run(result, resultAttachmentId, id);
}

export function countPendingTestsByFacility(
  facilityCode: string,
  datePrefix?: string
): number {
  const base = `SELECT COUNT(*) as c FROM lab_tests t
                JOIN visits v ON v.id = t.visit_id
                WHERE v.facility_code = ? AND t.status = 'Pending'`;
  const row = datePrefix
    ? (db
        .prepare(base + ' AND substr(t.created_at,1,10) = ?')
        .get(facilityCode, datePrefix) as any)
    : (db.prepare(base).get(facilityCode) as any);
  return row.c;
}

// ---- Attachments ----------------------------------------------------------

function rowToAttachment(row: any): Attachment {
  return {
    id: row.id,
    ownerType: row.owner_type,
    visitId: row.visit_id,
    originalName: row.original_name,
    storedName: row.stored_name,
    mime: row.mime,
    size: row.size,
    uploadedByRole: row.uploaded_by_role,
    createdAt: row.created_at,
  };
}

export function createAttachment(input: {
  visitId: number;
  originalName: string;
  storedName: string;
  mime: string;
  size: number;
  uploadedByRole: string;
}): Attachment {
  const info = db
    .prepare(
      `INSERT INTO attachments (owner_type, visit_id, original_name, stored_name, mime, size, uploaded_by_role, created_at)
       VALUES ('visit', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.visitId,
      input.originalName,
      input.storedName,
      input.mime,
      input.size,
      input.uploadedByRole,
      nowUtc()
    );
  return getAttachment(Number(info.lastInsertRowid))!;
}

export function getAttachment(id: number): Attachment | null {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  return row ? rowToAttachment(row) : null;
}

export function listAttachmentsForVisit(visitId: number): Attachment[] {
  const rows = db
    .prepare('SELECT * FROM attachments WHERE visit_id = ? ORDER BY id ASC')
    .all(visitId);
  return rows.map(rowToAttachment);
}

// ---- OTPs -----------------------------------------------------------------

function rowToOtp(row: any): Otp {
  return {
    id: row.id,
    context: row.context,
    targetEmail: row.target_email,
    codeHash: row.code_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}

export function createOtp(input: {
  context: string;
  targetEmail: string;
  codeHash: string;
  expiresAt: string;
}): Otp {
  // Invalidate any prior un-consumed OTPs for the same context.
  db.prepare(
    `UPDATE otps SET consumed_at = ? WHERE context = ? AND consumed_at IS NULL`
  ).run(nowUtc(), input.context);
  const info = db
    .prepare(
      `INSERT INTO otps (context, target_email, code_hash, expires_at, attempts, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`
    )
    .run(input.context, input.targetEmail, input.codeHash, input.expiresAt, nowUtc());
  return getOtp(Number(info.lastInsertRowid))!;
}

export function getOtp(id: number): Otp | null {
  const row = db.prepare('SELECT * FROM otps WHERE id = ?').get(id);
  return row ? rowToOtp(row) : null;
}

export function getLatestActiveOtp(context: string): Otp | null {
  const row = db
    .prepare(
      `SELECT * FROM otps WHERE context = ? AND consumed_at IS NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get(context);
  return row ? rowToOtp(row) : null;
}

export function incrementOtpAttempts(id: number): void {
  db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE id = ?').run(id);
}

export function consumeOtp(id: number): void {
  db.prepare('UPDATE otps SET consumed_at = ? WHERE id = ?').run(nowUtc(), id);
}
