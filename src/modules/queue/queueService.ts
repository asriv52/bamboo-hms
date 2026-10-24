import { recordAudit } from '../../core/audit';
import { requireRole, AccessDenied } from '../../core/accessControl';
import { todayUtcDatePrefix } from '../../core/db';
import {
  createQueueEntry,
  getPatientById,
  getQueueEntry,
  listTodayQueue,
  updateQueueStatus,
} from '../../core/entityStore';
import { Actor, Patient, QueueEntry, QueueStatus } from '../../core/types';

/**
 * Queue domain module. Goes through core services only; never imports another
 * domain module and never touches the DB directly.
 */
export function addToQueue(
  actor: Actor,
  patientId: number,
  department?: string
): QueueEntry {
  requireRole(actor, 'Receptionist');
  const patient = getPatientById(patientId);
  if (!patient) throw new AccessDenied('That patient could not be found.');

  const dept = (department && department.trim()) || actor.department || 'General';
  const entry = createQueueEntry(patientId, actor.facilityCode, dept);
  recordAudit({
    actor,
    action: 'queue_add',
    entity: 'queue_entry',
    entityId: entry.id,
    detail: `Patient ${patientId} added to queue (${dept})`,
  });
  return entry;
}

export function transitionQueue(actor: Actor, entryId: number, status: QueueStatus): void {
  requireRole(actor, 'Receptionist', 'Doctor');
  const entry = getQueueEntry(entryId);
  if (!entry || entry.facilityCode !== actor.facilityCode) {
    throw new AccessDenied('That queue entry could not be found.');
  }
  updateQueueStatus(entryId, status);
  recordAudit({
    actor,
    action: 'queue_transition',
    entity: 'queue_entry',
    entityId: entryId,
    detail: `Status -> ${status}`,
  });
}

export function todaysQueue(
  actor: Actor
): Array<QueueEntry & { patient: Patient | null }> {
  requireRole(actor, 'Receptionist', 'Doctor');
  const entries = listTodayQueue(actor.facilityCode, todayUtcDatePrefix());
  return entries.map((e) => ({ ...e, patient: getPatientById(e.patientId) }));
}
