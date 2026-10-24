import { recordAudit } from '../../core/audit';
import {
  assertDoctorCanReadHistory,
  canDoctorReadHistory,
  requireRole,
  AccessDenied,
} from '../../core/accessControl';
import { randomToken } from '../../core/crypto';
import {
  createPrescription,
  createVisit,
  finalizeVisit,
  getPatientById,
  getVisit,
  listVisitsForPatient,
  updateQueueStatus,
} from '../../core/entityStore';
import { enqueueEmail } from '../../core/notificationService';
import { Actor, Medication, Patient, Prescription, Visit } from '../../core/types';
import { requireText, ValidationError } from '../../core/validation';

/**
 * Consultation + prescription domain module. Opening a visit grants the doctor
 * scoped read/write for that patient. Finalizing produces an active medication
 * plan and queues patient emails. All mutations are audited.
 */

export function openVisit(
  actor: Actor,
  patientId: number,
  queueEntryId: number | null
): Visit {
  requireRole(actor, 'Doctor');
  const patient = getPatientById(patientId);
  if (!patient) throw new AccessDenied('That patient could not be found.');

  const visit = createVisit({
    patientId,
    doctorId: actor.userId,
    queueEntryId,
    facilityCode: actor.facilityCode,
  });
  if (queueEntryId) updateQueueStatus(queueEntryId, 'InProgress');

  recordAudit({
    actor,
    action: 'visit_open',
    entity: 'visit',
    entityId: visit.id,
    detail: `Opened visit for patient ${patientId}`,
  });
  return visit;
}

export interface PatientSummary {
  patient: Patient;
  history: Visit[];
  canReadHistory: boolean;
}

export function getPatientSummary(actor: Actor, patientId: number): PatientSummary {
  requireRole(actor, 'Doctor');
  const patient = getPatientById(patientId);
  if (!patient) throw new AccessDenied('That patient could not be found.');

  // History is only returned when the access rules permit it.
  const allowed = canDoctorReadHistory(actor, patientId);
  return {
    patient,
    history: allowed ? listVisitsForPatient(patientId) : [],
    canReadHistory: allowed,
  };
}

export function finalizeConsultation(
  actor: Actor,
  visitId: number,
  input: { diagnosis: string; notes: string; medications: Medication[] }
): { visit: Visit; prescription: Prescription | null } {
  requireRole(actor, 'Doctor');
  const visit = getVisit(visitId);
  if (!visit || visit.doctorId !== actor.userId) {
    throw new AccessDenied('That visit could not be found.');
  }
  if (visit.status === 'Finalized') {
    throw new ValidationError('This visit has already been finalized.');
  }

  const diagnosis = requireText(input.diagnosis, 'Diagnosis');
  const notes = (input.notes ?? '').toString().trim();

  finalizeVisit(visitId, diagnosis, notes);
  recordAudit({
    actor,
    action: 'visit_finalize',
    entity: 'visit',
    entityId: visitId,
    detail: `Diagnosis recorded`,
  });

  let prescription: Prescription | null = null;
  const meds = (input.medications || []).filter((m) => m && m.name && m.name.trim());
  if (meds.length > 0) {
    prescription = createPrescription({
      visitId,
      patientId: visit.patientId,
      medications: meds,
      pharmacyLookupToken: randomToken(),
    });
    recordAudit({
      actor,
      action: 'prescription_issue',
      entity: 'prescription',
      entityId: prescription.id,
      detail: `${meds.length} medication(s)`,
    });
  }

  // Close out the queue entry.
  if (visit.queueEntryId) updateQueueStatus(visit.queueEntryId, 'Completed');

  // Patient notifications — queued; finalize already succeeded.
  const patient = getPatientById(visit.patientId)!;
  enqueueEmail('visit_summary', patient.email, {
    name: patient.name,
    date: visit.createdAt.slice(0, 10),
    diagnosis,
    notes: notes || '(none)',
  });
  if (prescription) {
    enqueueEmail('prescription_issued', patient.email, {
      name: patient.name,
      medications: prescription.medications,
      token: prescription.pharmacyLookupToken,
    });
  }

  return { visit: getVisit(visitId)!, prescription };
}
