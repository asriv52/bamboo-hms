import { doctorHasVisitWithPatient, getPatientById, hasActiveGrant } from './entityStore';
import { Actor, Patient } from './types';

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
  if (doctorHasVisitWithPatient(actor.userId, patientId)) return true;
  if (hasActiveGrant(actor.userId, patientId)) return true;
  return false;
}

export function assertDoctorCanReadHistory(actor: Actor, patientId: number): void {
  requireRole(actor, 'Doctor');
  if (!canDoctorReadHistory(actor, patientId)) {
    throw new AccessDenied();
  }
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
      assertDoctorCanReadHistory(actor, patientId);
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
