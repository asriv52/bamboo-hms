import { recordAudit } from './audit';
import { getPatientInsurance, insertCharge } from './commerceStore';
import { Actor, Charge } from './types';

/**
 * Core charge creation. Lives in the core so domain modules (consultation,
 * pharmacy) can bill a patient without importing each other. Applies the
 * patient's insurance coverage to split the amount into insurer / patient
 * portions. Amounts are integer cents.
 */
export function splitWithInsurance(
  patientId: number,
  amountCents: number
): { insuranceCents: number; patientCents: number } {
  const coverage = getPatientInsurance(patientId);
  const pct = coverage ? Math.max(0, Math.min(100, coverage.plan.coveragePercent)) : 0;
  const insuranceCents = Math.round((amountCents * pct) / 100);
  return { insuranceCents, patientCents: amountCents - insuranceCents };
}

export function billPatient(
  actor: Actor,
  input: {
    patientId: number;
    facilityCode: string;
    source: Charge['source'];
    sourceId: number | null;
    description: string;
    amountCents: number;
    referringFacilityCode?: string | null;
  }
): Charge {
  const split = splitWithInsurance(input.patientId, input.amountCents);
  const charge = insertCharge({
    patientId: input.patientId,
    facilityCode: input.facilityCode,
    source: input.source,
    sourceId: input.sourceId,
    description: input.description,
    amountCents: input.amountCents,
    insuranceCents: split.insuranceCents,
    patientCents: split.patientCents,
    referringFacilityCode: input.referringFacilityCode ?? null,
  });
  recordAudit({
    actor,
    action: 'charge_create',
    entity: 'charge',
    entityId: charge.id,
    detail: `${input.source} charge ${input.amountCents}c`,
  });
  return charge;
}

/** Format integer cents for display (transport-agnostic helper). */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
