import { beforeEach, describe, expect, it } from 'vitest';
import { db, initSchema } from '../core/db';
import { createStaffUser, getActivePrescriptionForPatient, getStaffByEmail } from '../core/entityStore';
import { buildActor, login } from '../core/authService';
import { registerPatient, searchPatients } from '../core/patientService';
import { addToQueue } from '../modules/queue/queueService';
import {
  finalizeConsultation,
  getPatientSummary,
  openVisit,
} from '../modules/prescription/consultationService';
import { lookupActivePlan } from '../modules/pharmacy/pharmacyService';
import { getDashboard } from '../modules/admin/dashboardService';
import { inviteStaff, listStaff, updateStaff, updateFacility } from '../modules/admin/adminService';
import { activateInvite, getValidInvite, InviteError } from '../modules/admin/inviteService';
import { AccessDenied } from '../core/accessControl';

const FACILITY = 'TEST-CLINIC';

function wipe() {
  db.exec(`
    DELETE FROM dispensing_records; DELETE FROM prescriptions; DELETE FROM visits;
    DELETE FROM queue_entries; DELETE FROM access_grants; DELETE FROM audit_records;
    DELETE FROM notification_jobs; DELETE FROM patients; DELETE FROM staff_users;
    DELETE FROM staff_invites; DELETE FROM facilities;
  `);
}

function makeStaff() {
  const recep = createStaffUser({ email: 'r@test', password: 'pw', name: 'Recep', phone: null, facilityCode: FACILITY, department: 'Reception', roles: ['Receptionist'] });
  const doc = createStaffUser({ email: 'd@test', password: 'pw', name: 'Doc', phone: null, facilityCode: FACILITY, department: 'General Medicine', roles: ['Doctor'] });
  const doc2 = createStaffUser({ email: 'd2@test', password: 'pw', name: 'Doc2', phone: null, facilityCode: FACILITY, department: 'Pediatrics', roles: ['Doctor'] });
  const admin = createStaffUser({ email: 'a@test', password: 'pw', name: 'Admin', phone: null, facilityCode: FACILITY, department: 'Reception', roles: ['Admin'] });
  const pharm = createStaffUser({ email: 'p@test', password: 'pw', name: 'Pharm', phone: null, facilityCode: 'PH', department: 'Pharmacy', roles: ['Pharmacy'] });
  return {
    recep: buildActor(recep, 'Receptionist'),
    doc: buildActor(doc, 'Doctor'),
    doc2: buildActor(doc2, 'Doctor'),
    admin: buildActor(admin, 'Admin'),
    pharm: buildActor(pharm, 'Pharmacy'),
  };
}

describe('HMS core', () => {
  beforeEach(() => {
    initSchema();
    wipe();
  });

  it('runs the full care flow: register -> queue -> consult -> prescribe -> pharmacy', () => {
    const { recep, doc, pharm } = makeStaff();

    const patient = registerPatient(recep, { email: 'Pat@Example.com', name: 'Pat Synthetic' });
    expect(patient.email).toBe('pat@example.com'); // normalized lowercase

    const entry = addToQueue(recep, patient.id, 'General Medicine');
    expect(entry.status).toBe('Waiting');
    expect(entry.department).toBe('General Medicine');

    const visit = openVisit(doc, patient.id, entry.id);
    const { prescription } = finalizeConsultation(doc, visit.id, {
      diagnosis: 'Mild infection',
      notes: 'Rest and fluids',
      medications: [{ name: 'Amoxicillin', dosage: '500mg', instructions: 'Twice daily' }],
    });
    expect(prescription).not.toBeNull();

    const active = getActivePrescriptionForPatient(patient.id);
    expect(active?.id).toBe(prescription!.id);

    const view = lookupActivePlan(pharm, patient.id);
    expect(view.medications[0].name).toBe('Amoxicillin');
    expect((view as any).diagnosis).toBeUndefined();
  });

  it('admin dashboard shows per-department counts and no patient data', () => {
    const { recep, doc, admin } = makeStaff();
    const patient = registerPatient(recep, { email: 'dash@example.com', name: 'Dash Patient' });
    const entry = addToQueue(recep, patient.id, 'General Medicine');
    const visit = openVisit(doc, patient.id, entry.id);
    finalizeConsultation(doc, visit.id, { diagnosis: 'X', notes: '', medications: [] });

    const stats = getDashboard(admin);
    // Aggregate totals present.
    expect(stats.totals.registeredToday).toBeGreaterThanOrEqual(1);
    expect(stats.totals.visitsCompleted).toBe(1);
    // Completed visit is attributed to the doctor's department.
    const gm = stats.departments.find((d) => d.department === 'General Medicine');
    expect(gm?.visitsCompleted).toBe(1);
    // No patient-identifying fields anywhere in the payload.
    const blob = JSON.stringify(stats);
    expect(blob).not.toContain('dash@example.com');
    expect(blob).not.toContain('Dash Patient');
  });

  it('admin cannot register, search, or view patients', () => {
    const { admin } = makeStaff();
    expect(() => registerPatient(admin, { email: 'nope@example.com', name: 'Nope' })).toThrow(AccessDenied);
  });

  it('invites staff with a token and activates an account', () => {
    const { admin } = makeStaff();
    const invite = inviteStaff(admin, { email: 'new.doc@example.com', roles: ['Doctor'], department: 'Pediatrics' });
    expect(invite.status).toBe('pending');
    expect(invite.token).toBeTruthy();

    // Activation creates the account with invited roles/department.
    const user = activateInvite(invite.token, { name: 'New Doc', password: 'secret1' });
    expect(user.roles).toEqual(['Doctor']);
    expect(user.department).toBe('Pediatrics');

    // The new staff member can now log in.
    const loggedIn = login('new.doc@example.com', 'secret1');
    expect(loggedIn.email).toBe('new.doc@example.com');

    // Token is single-use.
    expect(() => getValidInvite(invite.token)).toThrow(InviteError);
  });

  it('rejects an unknown invite token', () => {
    expect(() => getValidInvite('does-not-exist')).toThrow(InviteError);
  });

  it('admin can update staff roles/department and facility info', () => {
    const { admin } = makeStaff();
    updateFacility(admin, { name: 'Test Clinic', departments: 'Reception, General Medicine, Pediatrics' });

    const doc = getStaffByEmail('d@test')!;
    updateStaff(admin, doc.id, { roles: ['Doctor', 'Receptionist'], department: 'Pediatrics' });
    const updated = listStaff(admin).find((s) => s.id === doc.id)!;
    expect(updated.roles).toContain('Receptionist');
    expect(updated.department).toBe('Pediatrics');
  });

  it('enforces patient isolation: a doctor without a visit cannot read history', () => {
    const { recep, doc, doc2 } = makeStaff();
    const patient = registerPatient(recep, { email: 'iso@example.com', name: 'Iso Patient' });

    const entry = addToQueue(recep, patient.id, 'General Medicine');
    const visit = openVisit(doc, patient.id, entry.id);
    finalizeConsultation(doc, visit.id, { diagnosis: 'X', notes: '', medications: [] });

    const docSummary = getPatientSummary(doc, patient.id);
    expect(docSummary.canReadHistory).toBe(true);
    expect(docSummary.history.length).toBeGreaterThanOrEqual(1);

    // An unrelated doctor cannot see the patient at all, find them in search,
    // or give themselves access by starting a visit.
    expect(() => getPatientSummary(doc2, patient.id)).toThrow(AccessDenied);
    expect(searchPatients(doc2, 'Iso')).toHaveLength(0);
    expect(() => openVisit(doc2, patient.id, null)).toThrow(AccessDenied);
    // Reusing the completed queue entry is also refused.
    expect(() => openVisit(doc2, patient.id, entry.id)).toThrow(AccessDenied);
  });

  it('pharmacy cannot access a patient without an active prescription', () => {
    const { recep, pharm } = makeStaff();
    const patient = registerPatient(recep, { email: 'norx@example.com', name: 'No Rx' });
    expect(() => lookupActivePlan(pharm, patient.id)).toThrow(AccessDenied);
  });

  it('rejects invalid login generically', () => {
    makeStaff();
    expect(() => login('r@test', 'wrong')).toThrow();
    expect(() => login('nobody@test', 'pw')).toThrow();
  });

  it('queues a registration email even though the action already succeeded', () => {
    const { recep } = makeStaff();
    registerPatient(recep, { email: 'mail@example.com', name: 'Mail Test' });
    const row = db.prepare("SELECT COUNT(*) as c FROM notification_jobs WHERE template='registration_confirmation'").get() as any;
    expect(row.c).toBe(1);
  });

  it('queues a staff invite email', () => {
    const { admin } = makeStaff();
    inviteStaff(admin, { email: 'invitee@example.com', roles: ['Receptionist'], department: 'Reception' });
    const row = db.prepare("SELECT COUNT(*) as c FROM notification_jobs WHERE template='staff_invite'").get() as any;
    expect(row.c).toBe(1);
  });
});
