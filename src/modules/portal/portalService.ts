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
import { issueOtp, verifyOtp } from '../../core/otpService';
import { normalizeEmail } from '../../core/validation';
import {
  Attachment,
  LabTest,
  Patient,
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
