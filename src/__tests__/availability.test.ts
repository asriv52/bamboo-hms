import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db, initSchema } from '../core/db';
import { createApp } from '../transport/web/app';
import {
  createBed,
  createPatient,
  createStaffUser,
  createVisit,
  getBed,
  getPatientByEmail,
  getStaffByEmail,
  listBedsByFacility,
  updateBedStatus,
} from '../core/entityStore';

const FACILITY = 'AVAIL-CLINIC';
const OTHER = 'OTHER-CLINIC';

function wipe() {
  db.exec(`
    DELETE FROM attachments; DELETE FROM lab_tests; DELETE FROM otps;
    DELETE FROM dispensing_records; DELETE FROM prescriptions; DELETE FROM visits;
    DELETE FROM beds; DELETE FROM equipment;
    DELETE FROM queue_entries; DELETE FROM access_grants; DELETE FROM audit_records;
    DELETE FROM notification_jobs; DELETE FROM patients; DELETE FROM staff_users;
    DELETE FROM staff_invites; DELETE FROM facilities;
  `);
}

function seed() {
  createStaffUser({ email: 'recep@avail.dev', password: 'pw', name: 'Rhea Recep', phone: null, facilityCode: FACILITY, department: 'Reception', roles: ['Receptionist'] });
  createStaffUser({ email: 'admin@avail.dev', password: 'pw', name: 'Admin', phone: null, facilityCode: FACILITY, department: 'Reception', roles: ['Admin'] });
  createStaffUser({ email: 'doc@avail.dev', password: 'pw', name: 'Dr. Okafor', phone: null, facilityCode: FACILITY, department: 'General Medicine', roles: ['Doctor'] });
  // Beds + equipment for this facility.
  createBed({ facilityCode: FACILITY, ward: 'Regular', room: 'R-101', label: 'A', status: 'Available' });
  createBed({ facilityCode: FACILITY, ward: 'Emergency', room: 'ER-1', label: 'A', status: 'Occupied' });
  // A bed owned by ANOTHER facility, to prove cross-facility writes are blocked.
  createBed({ facilityCode: OTHER, ward: 'Regular', room: 'X-1', label: 'A', status: 'Available' });
}

/** Seed an OPEN visit for a patient+doctor assigned to a bed, returning the bed. */
function seedOccupancy() {
  const doctor = getStaffByEmail('doc@avail.dev')!;
  const patient = createPatient({
    email: 'occ@example.test', name: 'Occupant Opal', phone: null,
    nationalId: null, address: null, bloodType: null, allergies: null,
  });
  const bed = listBedsByFacility(FACILITY).find((b) => b.room === 'ER-1')!;
  createVisit({ patientId: patient.id, doctorId: doctor.id, queueEntryId: null, facilityCode: FACILITY, bedId: bed.id });
  updateBedStatus(FACILITY, bed.id, 'Occupied');
  return { bed, patientName: 'Occupant Opal', doctorName: 'Dr. Okafor' };
}

async function loginAs(email: string) {
  const agent = request.agent(createApp());
  const res = await agent.post('/login').type('form').send({ email, password: 'pw' });
  expect([302, 303]).toContain(res.status);
  return agent;
}

describe('Bed & equipment availability (Receptionist)', () => {
  beforeEach(() => { initSchema(); wipe(); seed(); });

  it('shows the availability button on the receptionist dashboard', async () => {
    const recep = await loginAs('recep@avail.dev');
    const dash = await recep.get('/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.text).toContain('/availability');
  });

  it('renders the seat-map page with wards, beds, and equipment', async () => {
    const recep = await loginAs('recep@avail.dev');
    const page = await recep.get('/availability');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Regular ward');
    expect(page.text).toContain('Emergency ward');
    expect(page.text).toContain('Room R-101');
    expect(page.text).toContain('class="seat');
  });

  it('shows which patient and doctor occupy a bed', async () => {
    const occ = seedOccupancy();
    const recep = await loginAs('recep@avail.dev');
    const page = await recep.get('/availability');
    expect(page.status).toBe(200);
    expect(page.text).toContain(occ.patientName);
    expect(page.text).toContain(occ.doctorName);
  });

  it('updates a bed status within the facility', async () => {
    const recep = await loginAs('recep@avail.dev');
    const bed = listBedsByFacility(FACILITY).find((b) => b.room === 'R-101')!;
    const res = await recep
      .post(`/availability/beds/${bed.id}`)
      .type('form')
      .send({ status: 'Occupied' });
    expect([302, 303]).toContain(res.status);
    expect(getBed(bed.id)!.status).toBe('Occupied');
  });

  it('refuses to update a bed belonging to another facility', async () => {
    const recep = await loginAs('recep@avail.dev');
    const otherBed = listBedsByFacility(OTHER)[0];
    const res = await recep
      .post(`/availability/beds/${otherBed.id}`)
      .type('form')
      .send({ status: 'Occupied' });
    expect(res.status).toBe(400);
    expect(getBed(otherBed.id)!.status).toBe('Available');
  });

  it('rejects an unknown bed status', async () => {
    const recep = await loginAs('recep@avail.dev');
    const bed = listBedsByFacility(FACILITY)[0];
    const res = await recep
      .post(`/availability/beds/${bed.id}`)
      .type('form')
      .send({ status: 'Teleported' });
    expect(res.status).toBe(400);
  });

  it('blocks non-receptionists (admin, doctor) from the availability page', async () => {
    const admin = await loginAs('admin@avail.dev');
    expect((await admin.get('/availability')).status).toBe(403);
    const doc = await loginAs('doc@avail.dev');
    expect((await doc.get('/availability')).status).toBe(403);
  });

  it('assigns a patient + doctor to an available bed', async () => {
    const doctor = getStaffByEmail('doc@avail.dev')!;
    const patient = createPatient({
      email: 'assign@example.test', name: 'Assign Amy', phone: null,
      nationalId: null, address: null, bloodType: null, allergies: null,
    });
    const recep = await loginAs('recep@avail.dev');
    const bed = listBedsByFacility(FACILITY).find((b) => b.room === 'R-101')!;

    const res = await recep
      .post(`/availability/beds/${bed.id}/assign`)
      .type('form')
      .send({ patientId: String(patient.id), doctorId: String(doctor.id) });
    expect([302, 303]).toContain(res.status);
    expect(getBed(bed.id)!.status).toBe('Occupied');

    const page = await recep.get('/availability');
    expect(page.text).toContain('Assign Amy');
    expect(page.text).toContain('Dr. Okafor');
  });

  it('freeing a bed removes the occupant but keeps the patient in the database', async () => {
    const occ = seedOccupancy(); // Occupant Opal in ER-1
    const recep = await loginAs('recep@avail.dev');

    // Set the bed Available -> occupant should be released.
    const res = await recep
      .post(`/availability/beds/${occ.bed.id}`)
      .type('form')
      .send({ status: 'Available' });
    expect([302, 303]).toContain(res.status);

    // The bed is now free and the occupancy card is gone (the name may still
    // appear as an option in the empty bed's assign dropdown, which is fine).
    expect(getBed(occ.bed.id)!.status).toBe('Available');
    const page = await recep.get('/availability');
    expect(page.text).not.toContain('<b>Patient:</b> Occupant Opal');
    // But the patient still exists in the database.
    expect(getPatientByEmail('occ@example.test')).toBeTruthy();
  });

  it('remove-occupant endpoint frees the bed and keeps the patient', async () => {
    const occ = seedOccupancy();
    const recep = await loginAs('recep@avail.dev');

    const res = await recep.post(`/availability/beds/${occ.bed.id}/release`).type('form').send({});
    expect([302, 303]).toContain(res.status);
    expect(getBed(occ.bed.id)!.status).toBe('Available');
    // Occupancy card gone, patient preserved.
    const page = await recep.get('/availability');
    expect(page.text).not.toContain('<b>Patient:</b> Occupant Opal');
    expect(getPatientByEmail('occ@example.test')).toBeTruthy();
  });

  it('refuses to assign to a bed that is already occupied', async () => {
    const occ = seedOccupancy();
    const doctor = getStaffByEmail('doc@avail.dev')!;
    const other = createPatient({
      email: 'other@example.test', name: 'Other Person', phone: null,
      nationalId: null, address: null, bloodType: null, allergies: null,
    });
    const recep = await loginAs('recep@avail.dev');
    const res = await recep
      .post(`/availability/beds/${occ.bed.id}/assign`)
      .type('form')
      .send({ patientId: String(other.id), doctorId: String(doctor.id) });
    expect(res.status).toBe(400);
  });

  it('shows the patient distribution dashboard', async () => {
    seedOccupancy();
    const recep = await loginAs('recep@avail.dev');
    const page = await recep.get('/availability');
    expect(page.text).toContain('Patient distribution');
    expect(page.text).toContain('patient(s) currently in the building');
  });
});
