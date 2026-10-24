import { recordAudit } from '../../core/audit';
import { requireRole, AccessDenied } from '../../core/accessControl';
import {
  createDispensingRecord,
  getActivePrescriptionForPatient,
  getPatientById,
  getPrescriptionByToken,
} from '../../core/entityStore';
import { Actor, Medication, Prescription } from '../../core/types';
import { requireText } from '../../core/validation';

/**
 * Pharmacy domain module. A pharmacy can see ONLY a patient's active medication
 * plan, and only via a valid prescription (looked up by token or by an active
 * plan for a patient). It can never read diagnoses, notes, or other health data.
 */

export interface PharmacyView {
  patientName: string; // name is shown so the pharmacy can confirm identity
  medications: Medication[];
  prescriptionId: number;
}

export function lookupByToken(actor: Actor, token: string): PharmacyView {
  requireRole(actor, 'Pharmacy');
  const rx = getPrescriptionByToken(requireText(token, 'Lookup token'));
  if (!rx || !rx.isActivePlan) {
    throw new AccessDenied('No active prescription was found for that link.');
  }
  return toView(rx);
}

export function lookupActivePlan(actor: Actor, patientId: number): PharmacyView {
  requireRole(actor, 'Pharmacy');
  const rx = getActivePrescriptionForPatient(patientId);
  if (!rx) {
    throw new AccessDenied('No active prescription was found for that patient.');
  }
  return toView(rx);
}

function toView(rx: Prescription): PharmacyView {
  const patient = getPatientById(rx.patientId);
  // Deliberately expose only name + medications — nothing clinical.
  return {
    patientName: patient?.name ?? 'Unknown',
    medications: rx.medications,
    prescriptionId: rx.id,
  };
}

export function recordDispensing(
  actor: Actor,
  prescriptionId: number,
  itemsDispensed: string
): void {
  requireRole(actor, 'Pharmacy');
  createDispensingRecord({
    prescriptionId,
    pharmacyCode: actor.facilityCode,
    itemsDispensed: requireText(itemsDispensed, 'Items dispensed'),
  });
  recordAudit({
    actor,
    action: 'dispense',
    entity: 'prescription',
    entityId: prescriptionId,
    detail: 'Dispensing recorded',
  });
}
