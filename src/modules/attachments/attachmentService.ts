import { recordAudit } from '../../core/audit';
import { AccessDenied } from '../../core/accessControl';
import {
  createAttachment,
  doctorHasVisitWithPatient,
  getAttachment,
  getVisit,
  hasActiveGrant,
} from '../../core/entityStore';
import { saveBytes, validateUpload } from '../../core/fileStore';
import { Actor, Attachment } from '../../core/types';

/**
 * Attachment domain module. Staff upload/read files attached to a visit. Access
 * is enforced here at the data layer:
 *   - Doctors: only for visits of patients they have a qualifying relationship
 *     with (same rule as reading history).
 *   - Technicians: only for visits at their own facility (lab result context).
 *   - Receptionists/Admins/Pharmacy: no attachment access through this path.
 * Patient (portal) access is authorized separately in the portal module.
 */

function assertStaffCanAccessVisit(actor: Actor, visitId: number): void {
  const visit = getVisit(visitId);
  if (!visit) throw new AccessDenied('That visit could not be found.');

  switch (actor.activeRole) {
    case 'Doctor':
      if (
        doctorHasVisitWithPatient(actor.userId, visit.patientId) ||
        hasActiveGrant(actor.userId, visit.patientId)
      ) {
        return;
      }
      throw new AccessDenied();
    case 'Technician':
      if (visit.facilityCode === actor.facilityCode) return;
      throw new AccessDenied();
    default:
      throw new AccessDenied();
  }
}

export function uploadVisitAttachment(
  actor: Actor,
  visitId: number,
  file: { originalName: string; mime: string; buffer: Buffer }
): Attachment {
  assertStaffCanAccessVisit(actor, visitId);
  validateUpload(file.mime, file.buffer.length);

  const storedName = saveBytes(file.buffer, file.mime);
  const att = createAttachment({
    visitId,
    originalName: file.originalName,
    storedName,
    mime: file.mime,
    size: file.buffer.length,
    uploadedByRole: actor.activeRole,
  });
  recordAudit({
    actor,
    action: 'attachment_upload',
    entity: 'attachment',
    entityId: att.id,
    detail: `${file.originalName} on visit ${visitId}`,
  });
  return att;
}

/** Authorize a staff actor to read an attachment; returns it or throws. */
export function getStaffAttachment(actor: Actor, attachmentId: number): Attachment {
  const att = getAttachment(attachmentId);
  if (!att) throw new AccessDenied();
  assertStaffCanAccessVisit(actor, att.visitId);
  return att;
}
