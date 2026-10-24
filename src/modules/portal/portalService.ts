import { recordAudit } from '../../core/audit';
import {
  getActivePrescriptionForPatient,
  getAttachment,
  getPatientByEmail,
  getPatientById,
  getVisit,
  listAttachmentsForVisit,
  listLabTestsForVisit,
  listVisitsForPatient,
} from '../../core/entityStore';
import { listStock } from '../../core/commerceStore';
import { getFacility, listFacilities, listPrescriptionsForPatient } from '../../core/entityStore';
import {
  getPatientAccommodations,
  listFacilityAccommodations,
  setPatientAccommodations,
} from '../../core/opsStore';
import { issueOtp, verifyOtp } from '../../core/otpService';
import { normalizeEmail, ValidationError } from '../../core/validation';
import {
  ACCOMMODATIONS,
  Attachment,
  LabTest,
  Medication,
  Prescription,
  Visit,
} from '../../core/types';

/**
 * Patient portal — ACCOUNT-LEVEL self-service. A patient authenticates with
 * their email + an email-delivered OTP (patients have no password), then sees
 * ALL of their own visits/receipts and history in one place.
 *
 * Patient isolation is enforced here, not in the view: every read is scoped to
 * the patientId that owns the portal session. A session for patient A can never
 * load patient B's data — mismatches raise PortalAccessError, which carries a
 * single generic, non-leaking message.
 *
 * The per-visit access code still exists (used by staff and for quick single
 * receipt lookups), but the portal's primary experience is the full account.
 */

export class PortalAccessError extends Error {
  constructor(message = 'You do not have access to those records.') {
    super(message);
    this.name = 'PortalAccessError';
  }
}

function portalContext(patientId: number): string {
  return `portal:${patientId}`;
}

/**
 * Begin login: look up the patient by email and, if present, issue an OTP to
 * that email. To avoid leaking whether an email is registered, this function
 * never reveals the result — the caller always shows the same "code sent"
 * message regardless. Returns nothing.
 */
export function requestPortalOtp(emailRaw: string): void {
  let email: string;
  try {
    email = normalizeEmail(emailRaw);
  } catch {
    // Swallow format errors here too: do not reveal validity. The OTP step will
    // simply fail to verify if nothing was issued.
    return;
  }
  const patient = getPatientByEmail(email);
  if (!patient) {
    // No account — silently do nothing. The UI still says "code sent".
    return;
  }
  issueOtp(portalContext(patient.id), patient.email);
  recordAudit({
    actor: null,
    action: 'portal_otp_issue',
    entity: 'patient',
    entityId: patient.id,
    detail: 'Portal OTP issued',
  });
}

/**
 * Complete login: verify the OTP for the email. On success returns the patient
 * id to key the portal session to. On any failure returns null with no detail.
 */
export function verifyPortalOtp(emailRaw: string, code: string): number | null {
  let email: string;
  try {
    email = normalizeEmail(emailRaw);
  } catch {
    return null;
  }
  const patient = getPatientByEmail(email);
  if (!patient) return null;
  if (!verifyOtp(portalContext(patient.id), code)) return null;

  recordAudit({
    actor: null,
    action: 'portal_login',
    entity: 'patient',
    entityId: patient.id,
    detail: 'Portal login via OTP',
  });
  return patient.id;
}

export interface PortalPatient {
  id: number;
  name: string;
  email: string;
}

/** The authenticated portal patient, scoped strictly to their own id. */
export function getPortalPatient(patientId: number): PortalPatient {
  const patient = getPatientById(patientId);
  if (!patient) throw new PortalAccessError();
  return { id: patient.id, name: patient.name, email: patient.email };
}

export interface PortalVisitSummary {
  id: number;
  accessCode: string;
  date: string;
  status: Visit['status'];
  diagnosis: string | null;
  hasPrescription: boolean;
  testCount: number;
  attachmentCount: number;
}

/** List ALL of this patient's visits/receipts, newest first. */
export function listPortalVisits(patientId: number): PortalVisitSummary[] {
  const visits = listVisitsForPatient(patientId);
  const active = getActivePrescriptionForPatient(patientId);
  return visits.map((v) => ({
    id: v.id,
    accessCode: v.accessCode,
    date: v.createdAt.slice(0, 10),
    status: v.status,
    diagnosis: v.diagnosis,
    hasPrescription: !!active && active.visitId === v.id,
    testCount: listLabTestsForVisit(v.id).length,
    attachmentCount: listAttachmentsForVisit(v.id).length,
  }));
}

export interface PortalVisitDetail {
  visit: Visit;
  prescription: Prescription | null;
  tests: LabTest[];
  attachments: Attachment[];
}

/**
 * Detail for ONE of the patient's own visits. Enforces ownership: if the visit
 * does not belong to this patient, raise a non-leaking error.
 */
export function getPortalVisitDetail(
  patientId: number,
  visitId: number
): PortalVisitDetail {
  const visit = getVisit(visitId);
  if (!visit || visit.patientId !== patientId) {
    throw new PortalAccessError();
  }
  const active = getActivePrescriptionForPatient(patientId);
  const prescription = active && active.visitId === visit.id ? active : null;
  return {
    visit,
    prescription,
    tests: listLabTestsForVisit(visit.id),
    attachments: listAttachmentsForVisit(visit.id),
  };
}

// ---- Medication plan --------------------------------------------------------

export interface MedicationPlanItem extends Medication {
  /** UTC date (YYYY-MM-DD) the refill is due, when days of supply is known. */
  refillDue: string | null;
  refillOverdue: boolean;
  /** Pharmacies that list this medicine, cheapest first. */
  whereToRefill: Array<{ pharmacyName: string; address: string | null; hours: string | null; priceCents: number; inStock: boolean }>;
}

export interface MedicationPlan {
  active: { prescriptionId: number; issuedOn: string; items: MedicationPlanItem[] } | null;
  /** Earlier (discontinued) plans, kept distinct from the active plan (NP-05). */
  past: Array<{ prescriptionId: number; issuedOn: string; medications: Medication[] }>;
}

export function getMedicationPlan(patientId: number): MedicationPlan {
  const all = listPrescriptionsForPatient(patientId);
  const active = all.find((p) => p.isActivePlan) ?? null;
  const stock = listStock();
  return {
    active: active
      ? {
          prescriptionId: active.id,
          issuedOn: active.createdAt.slice(0, 10),
          items: active.medications.map((m) => {
            const due = m.daysSupply
              ? new Date(new Date(active.createdAt).getTime() + m.daysSupply * 86400_000)
              : null;
            const name = m.name.toLowerCase();
            return {
              ...m,
              refillDue: due ? due.toISOString().slice(0, 10) : null,
              refillOverdue: !!due && due.getTime() < Date.now(),
              whereToRefill: stock
                .filter((s) => s.medicationName.toLowerCase().includes(name) || name.includes(s.medicationName.toLowerCase()))
                .sort((a, b) => a.unitPriceCents - b.unitPriceCents)
                .map((s) => {
                  const f = getFacility(s.pharmacyCode);
                  return {
                    pharmacyName: f?.name ?? s.pharmacyCode,
                    address: f?.address ?? null,
                    hours: f?.operatingHours ?? null,
                    priceCents: s.unitPriceCents,
                    inStock: s.quantity > 0,
                  };
                }),
            };
          }),
        }
      : null,
    past: all
      .filter((p) => !p.isActivePlan)
      .map((p) => ({ prescriptionId: p.id, issuedOn: p.createdAt.slice(0, 10), medications: p.medications })),
  };
}

// ---- Accommodations ---------------------------------------------------------

export interface AccommodationView {
  options: readonly string[];
  needs: string[];
  /** Facilities that currently support ALL of the patient's needs. */
  supportingFacilities: Array<{ name: string; kind: string; address: string | null; available: Record<string, number> }>;
}

export function getAccommodations(patientId: number): AccommodationView {
  const needs = getPatientAccommodations(patientId);
  const byFacility = new Map<string, Record<string, number>>();
  for (const a of listFacilityAccommodations()) {
    const m = byFacility.get(a.facilityCode) ?? {};
    m[a.accommodation] = Math.max(0, a.capacity - a.inUse);
    byFacility.set(a.facilityCode, m);
  }
  const supportingFacilities = listFacilities()
    .filter((f) => needs.every((n) => (byFacility.get(f.code)?.[n] ?? 0) > 0))
    .filter(() => needs.length > 0)
    .map((f) => ({ name: f.name, kind: f.kind, address: f.address, available: byFacility.get(f.code) ?? {} }));
  return { options: ACCOMMODATIONS, needs, supportingFacilities };
}

export function setAccommodationNeeds(patientId: number, raw: unknown): void {
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const needs = [...new Set(arr.map(String))];
  if (needs.some((n) => !(ACCOMMODATIONS as readonly string[]).includes(n))) {
    throw new ValidationError('Choose accommodations from the list.');
  }
  setPatientAccommodations(patientId, needs);
  recordAudit({
    actor: null,
    action: 'accommodation_needs_set',
    entity: 'patient',
    entityId: patientId,
    detail: `${needs.length} need(s)`,
  });
}

/**
 * Authorize a portal patient to read a specific attachment. Confirms the
 * attachment belongs to one of the patient's own visits. Returns the
 * attachment, or throws a non-leaking error.
 */
export function getPortalAttachment(
  patientId: number,
  attachmentId: number
): Attachment {
  const att = getAttachment(attachmentId);
  if (!att) throw new PortalAccessError();
  const visit = getVisit(att.visitId);
  if (!visit || visit.patientId !== patientId) {
    throw new PortalAccessError();
  }
  return att;
}
