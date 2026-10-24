import { recordAudit } from './audit';
import { config } from './config';
import {
  createPatient,
  getPatientByEmail,
  searchPatients as storeSearch,
} from './entityStore';
import { enqueueEmail } from './notificationService';
import { Actor, Patient } from './types';
import { doctorCareContext, requireRole, AccessDenied } from './accessControl';
import {
  normalizeEmail,
  normalizePhone,
  optionalText,
  requireText,
  ValidationError,
} from './validation';

/**
 * Patient registration and lookup. Lives in the core layer because patient
 * identity is core data. Registration triggers a confirmation email via the
 * single notification service; a provider outage never fails registration.
 */
export function registerPatient(actor: Actor, input: Record<string, any>): Patient {
  // Only Receptionists register patients. Admin is HR/facility admin and has
  // no patient access.
  requireRole(actor, 'Receptionist');

  const email = normalizeEmail(input.email);
  const name = requireText(input.name, 'Name');
  const phone = normalizePhone(input.phone);
  const nationalId = optionalText(input.nationalId);
  const address = optionalText(input.address);
  const bloodType = optionalText(input.bloodType);
  const allergies = optionalText(input.allergies);

  if (getPatientByEmail(email)) {
    throw new ValidationError('A patient with this email is already registered.');
  }

  const patient = createPatient({
    email,
    name,
    phone,
    nationalId,
    address,
    bloodType,
    allergies,
  });

  recordAudit({
    actor,
    action: 'register',
    entity: 'patient',
    entityId: patient.id,
    detail: `Registered patient ${patient.email}`,
  });

  // Registration confirmation email — queued; registration already succeeded.
  enqueueEmail('registration_confirmation', patient.email, {
    name: patient.name,
    patientId: patient.id,
    facility: actor.facilityCode,
  });

  return patient;
}

export function searchPatients(actor: Actor, query: string): Patient[] {
  requireRole(actor, 'Receptionist', 'Doctor');
  if (!query || query.trim() === '') return [];
  const results = storeSearch(query);
  // Receptionists register and queue patients, so they search everyone.
  // Doctors only ever find patients they have a care relationship with.
  if (actor.activeRole === 'Doctor') {
    return results.filter((p) => doctorCareContext(actor, p.id) !== null);
  }
  return results;
}
