import { recordAudit } from '../../core/audit';
import { AccessDenied, requireFeature, requireRole } from '../../core/accessControl';
import { hmacCode } from '../../core/crypto';
import {
  createGrant,
  doctorHasVisitWithPatient,
  getGrant,
  getStaffById,
  listGrantsForFacility,
  listGrantsForPatient,
  revokeGrant,
} from '../../core/entityStore';
import { AccessGrant, Actor } from '../../core/types';
import { parseIntInRange, ValidationError } from '../../core/validation';

/**
 * Authorization grants (consent records). Grants are explicit, time-limited
 * access records that the patient can revoke at any time:
 *   - patient → doctor (patient-issued authorization)
 *   - treating doctor → peer doctor (peer authorization)
 * Admins see consent records DE-IDENTIFIED: a pseudonymous patient reference,
 * never a name, email, or patient id.
 */

const MAX_DAYS = 365;

function expiry(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

function grantStatus(g: AccessGrant): 'Active' | 'Revoked' | 'Expired' {
  if (g.revokedAt) return 'Revoked';
  if (new Date(g.expiresAt).getTime() <= Date.now()) return 'Expired';
  return 'Active';
}

export interface GrantView extends AccessGrant {
  doctorName: string;
  doctorFacility: string;
  status: 'Active' | 'Revoked' | 'Expired';
}

function toView(g: AccessGrant): GrantView {
  const doc = getStaffById(g.grantedToDoctorId);
  return {
    ...g,
    doctorName: doc?.name ?? 'Doctor',
    doctorFacility: doc?.facilityCode ?? '',
    status: grantStatus(g),
  };
}

function requireDoctor(doctorId: number) {
  const doc = Number.isInteger(doctorId) ? getStaffById(doctorId) : null;
  if (!doc || !doc.roles.includes('Doctor')) {
    throw new ValidationError('Choose a doctor from the list.');
  }
  return doc;
}

// ---- Patient side -----------------------------------------------------------

export function patientGrantAccess(patientId: number, doctorIdRaw: unknown, daysRaw: unknown): AccessGrant {
  const doc = requireDoctor(Number(doctorIdRaw));
  const days = parseIntInRange(daysRaw, 'Number of days', 1, MAX_DAYS);
  const grant = createGrant({ patientId, doctorId: doc.id, grantedBy: 'patient', expiresAt: expiry(days) });
  recordAudit({
    actor: null,
    action: 'grant_create',
    entity: 'access_grant',
    entityId: grant.id,
    detail: `Patient ${patientId} granted doctor ${doc.id} for ${days} day(s)`,
  });
  return grant;
}

export function patientListGrants(patientId: number): GrantView[] {
  return listGrantsForPatient(patientId).map(toView);
}

/** The patient can revoke ANY grant on their record, including peer grants. */
export function patientRevokeGrant(patientId: number, grantId: number): void {
  const g = getGrant(grantId);
  if (!g || g.patientId !== patientId) throw new AccessDenied('That access record could not be found.');
  revokeGrant(g.id);
  recordAudit({
    actor: null,
    action: 'grant_revoke',
    entity: 'access_grant',
    entityId: g.id,
    detail: `Revoked by patient ${patientId}`,
  });
}

// ---- Doctor side (peer authorization) --------------------------------------

/**
 * A treating doctor (one with an actual visit — not merely a grant, to stop
 * grant chains) can authorize a peer doctor on the patient's behalf.
 */
export function doctorPeerGrant(
  actor: Actor,
  patientId: number,
  toDoctorIdRaw: unknown,
  daysRaw: unknown
): AccessGrant {
  requireRole(actor, 'Doctor');
  if (!doctorHasVisitWithPatient(actor.userId, patientId)) {
    throw new AccessDenied('Only a treating doctor can share access to this patient.');
  }
  const peer = requireDoctor(Number(toDoctorIdRaw));
  if (peer.id === actor.userId) throw new ValidationError('Choose a different doctor.');
  const days = parseIntInRange(daysRaw, 'Number of days', 1, 90);
  const grant = createGrant({ patientId, doctorId: peer.id, grantedBy: 'peerDoctor', expiresAt: expiry(days) });
  recordAudit({
    actor,
    action: 'grant_create',
    entity: 'access_grant',
    entityId: grant.id,
    detail: `Peer grant to doctor ${peer.id} for ${days} day(s)`,
  });
  return grant;
}

// ---- Admin side (de-identified consent records) -----------------------------

export interface ConsentRecordView {
  id: number;
  patientRef: string;
  doctorName: string;
  grantedBy: 'patient' | 'peerDoctor';
  createdAt: string;
  expiresAt: string;
  status: 'Active' | 'Revoked' | 'Expired';
}

/** Stable, non-reversible pseudonym for a patient (no id, name, or email). */
export function patientPseudonym(patientId: number): string {
  return `PT-${hmacCode(`patient-ref:${patientId}`).slice(0, 8).toUpperCase()}`;
}

export function listConsentRecords(actor: Actor): ConsentRecordView[] {
  requireFeature(actor, 'consent_records');
  return listGrantsForFacility(actor.facilityCode).map((g) => ({
    id: g.id,
    patientRef: patientPseudonym(g.patientId),
    doctorName: getStaffById(g.grantedToDoctorId)?.name ?? 'Doctor',
    grantedBy: g.grantedBy,
    createdAt: g.createdAt,
    expiresAt: g.expiresAt,
    status: grantStatus(g),
  }));
}
