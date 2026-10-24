import { recordAudit } from '../../core/audit';
import { AccessDenied, requireFeature } from '../../core/accessControl';
import {
  getCharge,
  getInsurancePlan,
  getPatientInsurance,
  listChargesForFacility,
  listChargesForPatient,
  listServicePrices,
  setChargeStatus,
  setPatientInsurance,
} from '../../core/commerceStore';
import { splitWithInsurance } from '../../core/billingCore';
import { getFacility, getPatientById } from '../../core/entityStore';
import { Actor, Charge, PatientInsurance } from '../../core/types';
import { optionalText, ValidationError } from '../../core/validation';

/**
 * Billing + insurance module.
 *   - Patients: their own charges, what they owe, insurance-covered portions,
 *     and labeled cost ESTIMATES (never presented as final charges).
 *   - Pharmacies: billing records for their own pharmacy, split by patient,
 *     insurance, and referring hospital.
 *   - Receptionists: set a patient's insurance plan.
 */

export interface ChargeView extends Charge {
  facilityName: string;
  referringFacilityName: string | null;
}

function toView(c: Charge): ChargeView {
  return {
    ...c,
    facilityName: getFacility(c.facilityCode)?.name ?? c.facilityCode,
    referringFacilityName: c.referringFacilityCode
      ? getFacility(c.referringFacilityCode)?.name ?? c.referringFacilityCode
      : null,
  };
}

export interface EstimateView {
  facilityName: string;
  serviceName: string;
  condition: string | null;
  estimatedCents: number;
  /** Your expected share after your current coverage — still an estimate. */
  yourShareCents: number;
}

export interface PatientBilling {
  charges: ChargeView[];
  owedCents: number;
  insurancePendingCents: number;
  insurance: PatientInsurance | null;
  estimates: EstimateView[];
}

export function getPatientBilling(patientId: number): PatientBilling {
  const charges = listChargesForPatient(patientId).map(toView);
  const outstanding = charges.filter((c) => c.status === 'Outstanding');
  return {
    charges,
    owedCents: outstanding.reduce((s, c) => s + c.patientCents, 0),
    insurancePendingCents: outstanding.reduce((s, c) => s + c.insuranceCents, 0),
    insurance: getPatientInsurance(patientId),
    estimates: listServicePrices().map((p) => ({
      facilityName: getFacility(p.facilityCode)?.name ?? p.facilityCode,
      serviceName: p.serviceName,
      condition: p.condition,
      estimatedCents: p.estimatedCents,
      yourShareCents: splitWithInsurance(patientId, p.estimatedCents).patientCents,
    })),
  };
}

export function getPatientInsuranceSelf(patientId: number): PatientInsurance | null {
  return getPatientInsurance(patientId);
}

// ---- Receptionist: set coverage --------------------------------------------

export function setInsuranceForPatient(
  actor: Actor,
  patientId: number,
  input: { planId: unknown; memberId: unknown }
): void {
  requireFeature(actor, 'patient.insurance.set');
  if (!getPatientById(patientId)) throw new AccessDenied('That patient could not be found.');
  const plan = getInsurancePlan(Number(input.planId));
  if (!plan) throw new ValidationError('Choose an insurance plan from the list.');
  setPatientInsurance({ patientId, planId: plan.id, memberId: optionalText(input.memberId) });
  recordAudit({
    actor,
    action: 'insurance_set',
    entity: 'patient',
    entityId: patientId,
    detail: `Plan ${plan.id}`,
  });
}

export function getInsuranceForReceptionist(actor: Actor, patientId: number): PatientInsurance | null {
  requireFeature(actor, 'patient.insurance.set');
  return getPatientInsurance(patientId);
}

// ---- Pharmacy billing records ----------------------------------------------

export interface PharmacyBilling {
  charges: Array<ChargeView & { patientName: string }>;
  totals: { patientCents: number; insuranceCents: number; outstandingCents: number };
  byHospital: Array<{ hospital: string; count: number; amountCents: number }>;
}

export function getPharmacyBilling(actor: Actor): PharmacyBilling {
  requireFeature(actor, 'pharmacy.billing');
  const charges = listChargesForFacility(actor.facilityCode).map((c) => ({
    ...toView(c),
    // Only patients this pharmacy billed (i.e. dispensed to) appear here.
    patientName: getPatientById(c.patientId)?.name ?? 'Patient',
  }));
  const byHospital = new Map<string, { count: number; amountCents: number }>();
  for (const c of charges) {
    const key = c.referringFacilityName ?? 'No referring hospital';
    const cur = byHospital.get(key) ?? { count: 0, amountCents: 0 };
    byHospital.set(key, { count: cur.count + 1, amountCents: cur.amountCents + c.amountCents });
  }
  return {
    charges,
    totals: {
      patientCents: charges.reduce((s, c) => s + c.patientCents, 0),
      insuranceCents: charges.reduce((s, c) => s + c.insuranceCents, 0),
      outstandingCents: charges
        .filter((c) => c.status === 'Outstanding')
        .reduce((s, c) => s + c.amountCents, 0),
    },
    byHospital: [...byHospital.entries()].map(([hospital, v]) => ({ hospital, ...v })),
  };
}

export function markPharmacyChargePaid(actor: Actor, chargeId: number): void {
  requireFeature(actor, 'pharmacy.billing');
  const c = getCharge(chargeId);
  if (!c || c.facilityCode !== actor.facilityCode) throw new AccessDenied('That bill could not be found.');
  setChargeStatus(c.id, 'Paid');
  recordAudit({ actor, action: 'charge_paid', entity: 'charge', entityId: c.id });
}
