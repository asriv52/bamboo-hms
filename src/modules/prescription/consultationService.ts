import { recordAudit } from '../../core/audit';
import {
  assertDoctorCanReadHistory,
  canDoctorReadHistory,
  requireRole,
  AccessDenied,
} from '../../core/accessControl';
import { randomToken } from '../../core/crypto';
import {
  createLabTest,
  createPrescription,
  createVisit,
  finalizeVisit,
  getActivePrescriptionForPatient,
  getPatientById,
  getVisit,
  listAttachmentsForVisit,
  listLabTestsForVisit,
  listVisitsForPatient,
  updateQueueStatus,
} from '../../core/entityStore';
import { enqueueEmail } from '../../core/notificationService';
import {
  Actor,
  Attachment,
  LabTest,
  LabTestPriority,
  Medication,
  Patient,
  Prescription,
  Visit,
} from '../../core/types';
import { optionalText, requireText, ValidationError } from '../../core/validation';

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

/** A visit enriched with its tests and attachments for detailed views. */
export interface VisitDetail {
  visit: Visit;
  tests: LabTest[];
  attachments: Attachment[];
  prescription: Prescription | null;
}

export interface PatientSummary {
  patient: Patient;
  history: Visit[];
  canReadHistory: boolean;
  activePrescription: Prescription | null;
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
    activePrescription: allowed ? getActivePrescriptionForPatient(patientId) : null,
  };
}

/** Detail for one visit (tests + attachments + any prescription from it). */
export function getVisitDetailForDoctor(actor: Actor, visitId: number): VisitDetail {
  requireRole(actor, 'Doctor');
  const visit = getVisit(visitId);
  if (!visit) throw new AccessDenied('That visit could not be found.');
  // A doctor may read a visit's detail when they qualify for that patient's history.
  assertDoctorCanReadHistory(actor, visit.patientId);
  return buildVisitDetail(visit);
}

/** Internal: assemble a VisitDetail. Callers must have already authorized. */
export function buildVisitDetail(visit: Visit): VisitDetail {
  const tests = listLabTestsForVisit(visit.id);
  const attachments = listAttachmentsForVisit(visit.id);
  const active = getActivePrescriptionForPatient(visit.patientId);
  const prescription = active && active.visitId === visit.id ? active : null;
  return { visit, tests, attachments, prescription };
}

export interface LabTestInput {
  testName: string;
  priority: LabTestPriority;
  notes: string | null;
}

/** Parse + validate recommended tests from raw input arrays. */
export function normalizeTests(raw: Array<Partial<LabTestInput>>): LabTestInput[] {
  const allowed: LabTestPriority[] = ['Low', 'Medium', 'High'];
  const out: LabTestInput[] = [];
  for (const t of raw) {
    const name = (t.testName ?? '').toString().trim();
    if (!name) continue;
    const priority = allowed.includes(t.priority as LabTestPriority)
      ? (t.priority as LabTestPriority)
      : 'Medium';
    out.push({ testName: name, priority, notes: optionalText(t.notes) });
  }
  return out;
}

export function finalizeConsultation(
  actor: Actor,
  visitId: number,
  input: {
    diagnosis: string;
    notes: string;
    medications: Medication[];
    tests?: LabTestInput[];
  }
): { visit: Visit; prescription: Prescription | null; tests: LabTest[] } {
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

  // Recommended lab tests (optional). Each is audited.
  const tests: LabTest[] = [];
  for (const t of input.tests ?? []) {
    const created = createLabTest({
      visitId,
      testName: t.testName,
      priority: t.priority,
      notes: t.notes,
    });
    tests.push(created);
    recordAudit({
      actor,
      action: 'test_recommend',
      entity: 'lab_test',
      entityId: created.id,
      detail: `${created.testName} (${created.priority})`,
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

  return { visit: getVisit(visitId)!, prescription, tests };
}
