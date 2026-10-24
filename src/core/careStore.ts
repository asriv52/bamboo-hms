import { db, nowUtc } from './db';
import { decryptPII, encryptPII } from './crypto';
import { Appointment, AppointmentStatus, EhrCategory, EhrRecord } from './types';

/**
 * Core data access for clinical-care entities: categorized EHR records,
 * technician-patient assignments, and appointments. Like entityStore, this is
 * the only place these tables are touched; callers must authorize first.
 */

// ---- EHR records ----------------------------------------------------------

function rowToEhr(row: any): EhrRecord {
  return {
    id: row.id,
    patientId: row.patient_id,
    visitId: row.visit_id,
    facilityCode: row.facility_code,
    category: row.category as EhrCategory,
    title: row.title,
    content: decryptPII(row.content) ?? '',
    authorId: row.author_id,
    createdAt: row.created_at,
  };
}

export function createEhrRecord(input: {
  patientId: number;
  visitId: number | null;
  facilityCode: string;
  category: EhrCategory;
  title: string;
  content: string;
  authorId: number | null;
}): EhrRecord {
  const info = db
    .prepare(
      `INSERT INTO ehr_records (patient_id, visit_id, facility_code, category, title, content, author_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.patientId,
      input.visitId,
      input.facilityCode,
      input.category,
      input.title,
      encryptPII(input.content),
      input.authorId,
      nowUtc()
    );
  const row = db.prepare('SELECT * FROM ehr_records WHERE id = ?').get(Number(info.lastInsertRowid));
  return rowToEhr(row);
}

/** All EHR records for a patient, optionally restricted to one category. */
export function listEhrForPatient(patientId: number, category?: EhrCategory): EhrRecord[] {
  const rows = category
    ? db
        .prepare(
          'SELECT * FROM ehr_records WHERE patient_id = ? AND category = ? ORDER BY created_at DESC'
        )
        .all(patientId, category)
    : db
        .prepare('SELECT * FROM ehr_records WHERE patient_id = ? ORDER BY created_at DESC')
        .all(patientId);
  return (rows as any[]).map(rowToEhr);
}

// ---- Technician assignments -------------------------------------------------

export function assignTechnician(technicianId: number, patientId: number, assignedBy: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO technician_assignments (technician_id, patient_id, assigned_by, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(technicianId, patientId, assignedBy, nowUtc());
}

export function isTechnicianAssigned(technicianId: number, patientId: number): boolean {
  return !!db
    .prepare('SELECT 1 FROM technician_assignments WHERE technician_id = ? AND patient_id = ?')
    .get(technicianId, patientId);
}

export function listPatientIdsForTechnician(technicianId: number): number[] {
  return (
    db
      .prepare(
        'SELECT patient_id FROM technician_assignments WHERE technician_id = ? ORDER BY id DESC'
      )
      .all(technicianId) as any[]
  ).map((r) => r.patient_id);
}

// ---- Doctor relationships ---------------------------------------------------

/** Distinct patient ids this doctor has seen in a visit. */
export function listPatientIdsForDoctor(doctorId: number): number[] {
  return (
    db
      .prepare(
        'SELECT patient_id, MAX(created_at) AS last FROM visits WHERE doctor_id = ? GROUP BY patient_id ORDER BY last DESC'
      )
      .all(doctorId) as any[]
  ).map((r) => r.patient_id);
}

// ---- Appointments -----------------------------------------------------------

function rowToAppointment(row: any): Appointment {
  return {
    id: row.id,
    patientId: row.patient_id,
    doctorId: row.doctor_id,
    facilityCode: row.facility_code,
    scheduledAt: row.scheduled_at,
    reason: row.reason,
    status: row.status as AppointmentStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createAppointment(input: {
  patientId: number;
  doctorId: number;
  facilityCode: string;
  scheduledAt: string;
  reason: string | null;
}): Appointment {
  const ts = nowUtc();
  const info = db
    .prepare(
      `INSERT INTO appointments (patient_id, doctor_id, facility_code, scheduled_at, reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'Scheduled', ?, ?)`
    )
    .run(input.patientId, input.doctorId, input.facilityCode, input.scheduledAt, input.reason, ts, ts);
  return getAppointment(Number(info.lastInsertRowid))!;
}

export function getAppointment(id: number): Appointment | null {
  const row = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  return row ? rowToAppointment(row) : null;
}

export function updateAppointment(
  id: number,
  fields: { scheduledAt?: string; status?: AppointmentStatus }
): void {
  const current = getAppointment(id);
  if (!current) return;
  db.prepare('UPDATE appointments SET scheduled_at = ?, status = ?, updated_at = ? WHERE id = ?').run(
    fields.scheduledAt ?? current.scheduledAt,
    fields.status ?? current.status,
    nowUtc(),
    id
  );
}

export function listAppointmentsForPatient(patientId: number): Appointment[] {
  return (
    db
      .prepare('SELECT * FROM appointments WHERE patient_id = ? ORDER BY scheduled_at DESC')
      .all(patientId) as any[]
  ).map(rowToAppointment);
}

/** A scheduled appointment with this doctor at or after `sinceIso`. */
export function doctorHasUpcomingAppointment(
  doctorId: number,
  patientId: number,
  sinceIso: string
): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM appointments
       WHERE doctor_id = ? AND patient_id = ? AND status = 'Scheduled' AND scheduled_at >= ?
       LIMIT 1`
    )
    .get(doctorId, patientId, sinceIso);
}

export function listAppointmentsForDoctor(doctorId: number): Appointment[] {
  return (
    db
      .prepare('SELECT * FROM appointments WHERE doctor_id = ? ORDER BY scheduled_at DESC')
      .all(doctorId) as any[]
  ).map(rowToAppointment);
}
