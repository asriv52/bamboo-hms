import { recordAudit } from './audit';
import {
  doctorHasUpcomingAppointment,
  isTechnicianAssigned,
  listAppointmentsForDoctor,
} from './careStore';
import { todayUtcDatePrefix } from './db';
import {
  doctorHasVisitWithPatient,
  getPatientById,
  getQueueEntry,
  getStaffById,
  hasActiveGrant,
  listTodayQueue,
  listVisitsForQueueEntry,
} from './entityStore';
import { Actor, EhrCategory, Patient, Role } from './types';

/**
 * The single authorization gate. Every read/write of protected data passes
 * through here. The UI layer is defense-in-depth; this is the source of truth.
 *
 * On denial we throw AccessDenied with a user-friendly message that never
 * leaks whether the target data exists or what it contains.
 */
export class AccessDenied extends Error {
  constructor(message = 'You do not have access to this information.') {
    super(message);
    this.name = 'AccessDenied';
  }
}

export function requireRole(actor: Actor, ...roles: Actor['activeRole'][]): void {
  if (!roles.includes(actor.activeRole)) {
    throw new AccessDenied();
  }
}

/**
 * Can this doctor read the patient's prior history (past visits + medication)?
 * Allowed when any of:
 *   1. the doctor has a past/active visit with the patient, OR
 *   2. the patient granted this doctor access (stored grant), OR
 *   3. a peer treating doctor granted access on the patient's behalf (stored grant).
 *
 * Doctor-as-patient isolation: a doctor reading a record that happens to be
 * their own patient record gets NO elevated access from the doctor role — the
 * same visit/grant rules apply, so nothing special is needed here.
 */
export function canDoctorReadHistory(actor: Actor, patientId: number): boolean {
  if (actor.activeRole !== 'Doctor') return false;
  // Doctor-as-patient: the doctor role never reads the doctor's own record.
  if (getPatientById(patientId)?.email === actor.email) return false;
  if (doctorHasVisitWithPatient(actor.userId, patientId)) return true;
  if (hasActiveGrant(actor.userId, patientId)) return true;
  return false;
}

export function assertDoctorCanReadHistory(actor: Actor, patientId: number): void {
  requireRole(actor, 'Doctor');
  if (!canDoctorReadHistory(actor, patientId)) {
    auditDenial(actor, 'patient', patientId, 'doctor history without relationship');
    throw new AccessDenied();
  }
}

/**
 * The doctor's care relationship with a patient:
 *   - 'treating': past/active visit, or an active patient/peer grant. Full
 *     clinical access (history, EHR, medication history).
 *   - 'pending':  the patient is waiting for care FROM THIS DOCTOR — in today's
 *     queue at the doctor's facility (not yet completed), or holding a
 *     scheduled appointment with this doctor that has not passed. Enough to
 *     identify the patient and start a consultation; no history.
 *   - null:       unrelated. The doctor may not see the patient at all.
 *
 * Doctor-as-patient isolation: a doctor never has a care relationship with
 * their own patient record through the doctor role.
 */
export type DoctorCareContext = 'treating' | 'pending' | null;

export function doctorCareContext(actor: Actor, patientId: number): DoctorCareContext {
  if (actor.activeRole !== 'Doctor') return null;
  const patient = getPatientById(patientId);
  if (!patient || patient.email === actor.email) return null;
  if (canDoctorReadHistory(actor, patientId)) return 'treating';
  if (findOpenQueueEntry(actor, patientId)) return 'pending';
  if (doctorHasUpcomingAppointment(actor.userId, patientId, startOfTodayUtc())) return 'pending';
  return null;
}

export function assertDoctorCareContext(actor: Actor, patientId: number): Exclude<DoctorCareContext, null> {
  requireRole(actor, 'Doctor');
  const ctx = doctorCareContext(actor, patientId);
  if (!ctx) {
    auditDenial(actor, 'patient', patientId, 'doctor has no care relationship');
    throw new AccessDenied();
  }
  return ctx;
}

/** Today's open (Waiting / InProgress) queue entry for this patient at the doctor's facility. */
export function findOpenQueueEntry(actor: Actor, patientId: number) {
  return (
    listTodayQueue(actor.facilityCode, todayUtcDatePrefix()).find(
      (e) => e.patientId === patientId && e.status !== 'Completed'
    ) ?? null
  );
}

function startOfTodayUtc(): string {
  return `${todayUtcDatePrefix()}T00:00:00.000Z`;
}

/**
 * May this doctor open a NEW visit (consultation) for the patient? A visit is
 * what grants clinical access, so it cannot be self-issued for arbitrary
 * patients. Allowed only when:
 *   1. a queue entry is given that is today's, at the doctor's facility, for
 *      this patient, not completed, and not already taken by another doctor; OR
 *   2. the doctor has a scheduled appointment with the patient TODAY; OR
 *   3. the doctor is already treating the patient (follow-up visit).
 * Never for the doctor's own patient record.
 */
export function assertDoctorCanOpenVisit(
  actor: Actor,
  patientId: number,
  queueEntryId: number | null
): void {
  requireRole(actor, 'Doctor');
  const patient = getPatientById(patientId);
  if (!patient || patient.email === actor.email) {
    auditDenial(actor, 'patient', patientId, 'open visit: unknown or own record');
    throw new AccessDenied('You cannot start a consultation for this patient.');
  }

  if (queueEntryId !== null) {
    const entry = getQueueEntry(queueEntryId);
    const takenByOther = entry
      ? listVisitsForQueueEntry(entry.id).some((v) => v.doctorId !== actor.userId)
      : false;
    if (
      entry &&
      entry.patientId === patientId &&
      entry.facilityCode === actor.facilityCode &&
      entry.status !== 'Completed' &&
      entry.createdAt.slice(0, 10) === todayUtcDatePrefix() &&
      !takenByOther
    ) {
      return;
    }
    auditDenial(actor, 'queue_entry', queueEntryId, 'open visit: invalid queue entry');
    throw new AccessDenied('That queue entry is not available to you.');
  }

  const today = todayUtcDatePrefix();
  const hasAppointmentToday = listAppointmentsForDoctor(actor.userId).some(
    (a) => a.patientId === patientId && a.status === 'Scheduled' && a.scheduledAt.slice(0, 10) === today
  );
  if (hasAppointmentToday || canDoctorReadHistory(actor, patientId)) return;

  auditDenial(actor, 'patient', patientId, 'open visit: no queue entry, appointment, or relationship');
  throw new AccessDenied(
    'You can only start a consultation for a patient in your queue, with an appointment with you today, or already under your care.'
  );
}

function auditDenial(actor: Actor, entity: string, entityId: number | null, detail: string): void {
  recordAudit({ actor, action: 'access_denied', entity, entityId, detail });
}

/**
 * Patient isolation helper: returns the patient only if the actor is allowed to
 * read it. Receptionists and admins at the facility may read basic patient
 * records (registration/queue context); doctors need a qualifying relationship;
 * pharmacies never read full patient records through this path.
 */
export function getPatientFor(actor: Actor, patientId: number): Patient {
  const patient = getPatientById(patientId);
  if (!patient) {
    // Same error as denial — do not reveal existence.
    throw new AccessDenied();
  }
  switch (actor.activeRole) {
    case 'Receptionist':
      return patient;
    case 'Doctor':
      // Identity requires at least a pending care relationship.
      assertDoctorCareContext(actor, patientId);
      return patient;
    // Admin is an HR / facility-admin role and has no access to patient data.
    case 'Admin':
    case 'Pharmacy':
    default:
      throw new AccessDenied();
  }
}

/** Guard for Admin-only (HR / facility) actions. */
export function requireAdmin(actor: Actor): void {
  requireRole(actor, 'Admin');
}

/**
 * Specialty-scoped technician EHR access. A technician may read a patient's
 * EHR records only when (a) they are assigned to that patient and (b) the
 * records are in the technician's own specialty category. Returns the single
 * category they may read; throws otherwise. Never returns 'General'.
 */
export function assertTechnicianEhrScope(actor: Actor, patientId: number): EhrCategory {
  requireRole(actor, 'Technician');
  const tech = getStaffById(actor.userId);
  if (!tech || !tech.specialty || tech.specialty === 'General') {
    throw new AccessDenied('Your account has no specialty assigned. Ask your admin to set one.');
  }
  if (!isTechnicianAssigned(actor.userId, patientId)) {
    throw new AccessDenied();
  }
  return tech.specialty;
}

/**
 * Staff feature matrix — the authoritative "Application Requirements by User
 * Class" table from steering, expressed in code. Services call
 * requireFeature() so the rule is enforced at the data layer, not in the UI.
 * Patients are not staff Actors; portal features are scoped by the portal
 * session's patient id inside the portal service instead.
 */
export type StaffFeature =
  | 'shared.directory'
  | 'shared.insurance_marketplace'
  | 'pharmacy.stock.read'
  | 'pharmacy.stock.manage'
  | 'pharmacy.purchase_history'
  | 'pharmacy.billing'
  | 'equipment.read'
  | 'equipment.manage'
  | 'rooms.manage'
  | 'staff_availability'
  | 'accommodations.manage'
  | 'consent_records'
  | 'admin.directory'
  | 'appointments.doctor'
  | 'ehr.doctor'
  | 'ehr.technician'
  | 'medication_history.doctor'
  | 'patient.insurance.set'
  | 'wearables.doctor'
  | 'wearables.research'
  | 'wearables.reidentify'
  | 'assistant.requests';

const ALL_STAFF: Role[] = ['Admin', 'Receptionist', 'Doctor', 'Pharmacy', 'Technician'];

export const FEATURE_MATRIX: Record<StaffFeature, Role[]> = {
  'shared.directory': ALL_STAFF,
  // Steering: shared baseline, except doctors (not needed for clinical work).
  'shared.insurance_marketplace': ALL_STAFF.filter((r) => r !== 'Doctor'),
  'pharmacy.stock.read': ['Doctor', 'Pharmacy'],
  'pharmacy.stock.manage': ['Pharmacy'],
  'pharmacy.purchase_history': ['Pharmacy'],
  'pharmacy.billing': ['Pharmacy'],
  'equipment.read': ['Admin', 'Doctor', 'Technician'],
  'equipment.manage': ['Admin'],
  'rooms.manage': ['Admin'],
  staff_availability: ['Admin'],
  'accommodations.manage': ['Admin'],
  consent_records: ['Admin'],
  'admin.directory': ['Admin'],
  'appointments.doctor': ['Doctor'],
  'ehr.doctor': ['Doctor'],
  'ehr.technician': ['Technician'],
  'medication_history.doctor': ['Doctor'],
  'patient.insurance.set': ['Receptionist'],
  // Wearable (WHOOP) data: doctors only. Identified data additionally needs a
  // care relationship (assertDoctorCanReadHistory); the research dataset is
  // de-identified; re-identification needs a care relationship + a reason.
  'wearables.doctor': ['Doctor'],
  'wearables.research': ['Doctor'],
  'wearables.reidentify': ['Doctor'],
  // Help-assistant log of unanswered questions (redacted), for product planning.
  'assistant.requests': ['Admin'],
};

export function canUseFeature(actor: Actor, feature: StaffFeature): boolean {
  return FEATURE_MATRIX[feature].includes(actor.activeRole);
}

export function requireFeature(actor: Actor, feature: StaffFeature): void {
  if (!canUseFeature(actor, feature)) {
    // Denials are audited (Security Specialist SS-02).
    recordAudit({
      actor,
      action: 'access_denied',
      entity: 'feature',
      entityId: null,
      detail: feature,
    });
    throw new AccessDenied();
  }
}
