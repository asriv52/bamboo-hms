import { recordAudit } from '../../core/audit';
import {
  AccessDenied,
  assertDoctorCanReadHistory,
  assertTechnicianEhrScope,
  requireFeature,
} from '../../core/accessControl';
import {
  assignTechnician as storeAssign,
  createEhrRecord,
  listEhrForPatient,
  listPatientIdsForTechnician,
} from '../../core/careStore';
import { getPatientById, getStaffById, getVisit, listStaffByFacility } from '../../core/entityStore';
import { Actor, EHR_CATEGORIES, EhrCategory, EhrRecord, StaffUser } from '../../core/types';
import { requireOneOf, requireText } from '../../core/validation';

/**
 * Categorized EHR module.
 *   - Doctors with a qualifying relationship (visit / grant) read all categories
 *     and add entries.
 *   - Patients read their own records (scoped by portal session id).
 *   - Technicians read ONLY their specialty's category, ONLY for patients they
 *     are assigned to, and see only the patient's name for identification.
 * Every protected read is audited (Security Specialist SS-06).
 */

export function addEhrRecord(
  actor: Actor,
  patientId: number,
  input: { category: unknown; title: unknown; content: unknown; visitId?: unknown }
): EhrRecord {
  requireFeature(actor, 'ehr.doctor');
  assertDoctorCanReadHistory(actor, patientId);
  const category = requireOneOf(input.category, EHR_CATEGORIES, 'Category');
  const title = requireText(input.title, 'Title');
  const content = requireText(input.content, 'Details');

  let visitId: number | null = null;
  if (input.visitId) {
    const v = getVisit(Number(input.visitId));
    if (v && v.patientId === patientId) visitId = v.id;
  }
  const rec = createEhrRecord({
    patientId,
    visitId,
    facilityCode: actor.facilityCode,
    category,
    title,
    content,
    authorId: actor.userId,
  });
  recordAudit({
    actor,
    action: 'ehr_create',
    entity: 'ehr_record',
    entityId: rec.id,
    detail: `${category} record for patient ${patientId}`,
  });
  return rec;
}

export function listEhrForDoctor(actor: Actor, patientId: number): EhrRecord[] {
  requireFeature(actor, 'ehr.doctor');
  assertDoctorCanReadHistory(actor, patientId);
  recordAudit({ actor, action: 'ehr_read', entity: 'patient', entityId: patientId, detail: 'All categories' });
  return listEhrForPatient(patientId);
}

export function listEhrForPatientSelf(patientId: number): EhrRecord[] {
  return listEhrForPatient(patientId);
}

// ---- Technician scope -------------------------------------------------------

export interface TechnicianPatientView {
  patientId: number;
  patientName: string;
  category: EhrCategory;
  records: EhrRecord[];
}

/** The technician's assigned patients, each with ONLY specialty records. */
export function listTechnicianPatients(actor: Actor): TechnicianPatientView[] {
  requireFeature(actor, 'ehr.technician');
  const out: TechnicianPatientView[] = [];
  for (const patientId of listPatientIdsForTechnician(actor.userId)) {
    const category = assertTechnicianEhrScope(actor, patientId);
    const patient = getPatientById(patientId);
    if (!patient) continue;
    out.push({
      patientId,
      patientName: patient.name,
      category,
      records: listEhrForPatient(patientId, category),
    });
  }
  recordAudit({ actor, action: 'ehr_read', entity: 'technician_scope', entityId: actor.userId, detail: `${out.length} patient(s)` });
  return out;
}

export function getTechnicianPatientEhr(actor: Actor, patientId: number): TechnicianPatientView {
  requireFeature(actor, 'ehr.technician');
  const category = assertTechnicianEhrScope(actor, patientId);
  const patient = getPatientById(patientId);
  if (!patient) throw new AccessDenied();
  recordAudit({ actor, action: 'ehr_read', entity: 'patient', entityId: patientId, detail: category });
  return { patientId, patientName: patient.name, category, records: listEhrForPatient(patientId, category) };
}

// ---- Doctor assigns a technician -------------------------------------------

export function listAssignableTechnicians(actor: Actor): StaffUser[] {
  requireFeature(actor, 'ehr.doctor');
  return listStaffByFacility(actor.facilityCode).filter(
    (s) => s.roles.includes('Technician') && s.specialty && s.specialty !== 'General'
  );
}

export function assignTechnicianToPatient(actor: Actor, patientId: number, technicianId: number): void {
  requireFeature(actor, 'ehr.doctor');
  assertDoctorCanReadHistory(actor, patientId);
  const tech = getStaffById(technicianId);
  if (
    !tech ||
    !tech.roles.includes('Technician') ||
    tech.facilityCode !== actor.facilityCode ||
    !tech.specialty
  ) {
    throw new AccessDenied('Choose a technician with a specialty at your facility.');
  }
  storeAssign(technicianId, patientId, actor.userId);
  recordAudit({
    actor,
    action: 'technician_assign',
    entity: 'patient',
    entityId: patientId,
    detail: `Technician ${technicianId} (${tech.specialty})`,
  });
}
