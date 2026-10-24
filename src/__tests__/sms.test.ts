import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db, initSchema } from '../core/db';
import {
  createPatient,
  createPrescription,
  createStaffUser,
  createVisit,
  getPatientByEmail,
  getStaffByEmail,
  upsertFacility,
} from '../core/entityStore';
import { createAppointment, createEhrRecord } from '../core/careStore';
import { upsertStock } from '../core/commerceStore';
import { clearSmsSessions, handleInboundSms } from '../modules/sms/smsService';
import { listEhrForPatient } from '../core/careStore';
import { createSmsApp } from '../transport/sms/smsSimulator';

const HOSPITAL = 'SMS-HOSP';
const PHARMACY = 'SMS-PHARM';
const PHONE = '+15551230001';

function wipe() {
  db.exec(`
    DELETE FROM charges; DELETE FROM patient_insurance; DELETE FROM insurance_plans;
    DELETE FROM service_prices; DELETE FROM pharmacy_stock; DELETE FROM appointments;
    DELETE FROM technician_assignments; DELETE FROM ehr_records;
    DELETE FROM patient_accommodations; DELETE FROM facility_accommodations;
    DELETE FROM rooms; DELETE FROM equipment; DELETE FROM staff_shifts;
    DELETE FROM attachments; DELETE FROM lab_tests; DELETE FROM otps;
    DELETE FROM dispensing_records; DELETE FROM prescriptions; DELETE FROM visits;
    DELETE FROM queue_entries; DELETE FROM access_grants; DELETE FROM audit_records;
    DELETE FROM notification_jobs; DELETE FROM beds; DELETE FROM patients;
    DELETE FROM staff_users; DELETE FROM staff_invites; DELETE FROM facilities;
  `);
}

function seed() {
  upsertFacility({ code: HOSPITAL, name: 'SMS Hospital', kind: 'Hospital', address: '1 Health Rd', phone: '+15550000000', operatingHours: 'Mon-Fri 9-5', departments: ['General'], specialties: 'General medicine' });
  upsertFacility({ code: PHARMACY, name: 'SMS Pharmacy', kind: 'Pharmacy', address: '2 Market St', phone: null, operatingHours: '7-21 daily', departments: ['Pharmacy'], specialties: null });
  createStaffUser({ email: 'doc@sms.dev', password: 'pw', name: 'Dr. SMS', phone: null, facilityCode: HOSPITAL, department: 'General', roles: ['Doctor'] });
  const doctor = getStaffByEmail('doc@sms.dev')!;

  const patient = createPatient({ email: 'sms.patient@example.test', name: 'Sam Patient', phone: PHONE, nationalId: null, address: null, bloodType: null, allergies: null });

  const visit = createVisit({ patientId: patient.id, doctorId: doctor.id, queueEntryId: null, facilityCode: HOSPITAL });
  createPrescription({
    visitId: visit.id, patientId: patient.id,
    medications: [{ name: 'Paracetamol', dosage: '500mg', instructions: 'Every 6h', daysSupply: 7 } as any],
    pharmacyLookupToken: 'tok-sms-1',
  });
  createEhrRecord({ patientId: patient.id, visitId: visit.id, facilityCode: HOSPITAL, category: 'General', title: 'Flu reviewed', content: 'Rest advised.', authorId: doctor.id });
  upsertStock({ pharmacyCode: PHARMACY, medicationName: 'Paracetamol', quantity: 50, unitPriceCents: 10, supplier: 'Demo' });
  createAppointment({ patientId: patient.id, doctorId: doctor.id, facilityCode: HOSPITAL, scheduledAt: new Date(Date.now() + 3 * 86400_000).toISOString(), reason: 'Follow-up' });

  return { patient, doctor };
}

const BUSY_PHONE = '+15551230002';

/** A second patient with 7 records across types (more than the direct-list limit). */
function seedBusyPatient(facilityCode: string, doctorId: number) {
  const busy = createPatient({ email: 'busy.patient@example.test', name: 'Bo Busy', phone: BUSY_PHONE, nationalId: null, address: null, bloodType: null, allergies: null });
  const plan: Array<[any, string]> = [
    ['Orthopedic', 'Wrist sprain'], ['Orthopedic', 'Knee strain'], ['Orthopedic', 'Ankle check'],
    ['Laboratory', 'Blood panel'], ['Laboratory', 'Vitamin D'],
    ['Cardiac', 'ECG screen'], ['General', 'Annual check-up'],
  ];
  for (const [category, title] of plan) {
    createEhrRecord({ patientId: busy.id, visitId: null, facilityCode, category, title, content: `${title} notes`, authorId: doctorId });
  }
  return busy;
}

describe('SMS simulator — patient-facing commands', () => {
  beforeEach(() => { initSchema(); wipe(); seed(); clearSmsSessions(); });

  it('HELP lists the available commands', () => {
    const r = handleInboundSms(PHONE, 'HELP');
    expect(r.lines.join(' ')).toContain('EHR');
    expect(r.lines.join(' ')).toContain('PHARMACY');
  });

  it('EHR returns the patient\'s own records', () => {
    const r = handleInboundSms(PHONE, 'EHR');
    expect(r.lines.join('\n')).toContain('Flu reviewed');
  });

  it('EHR with few records lists numbered options, and a number opens the detail', () => {
    const list = handleInboundSms(PHONE, 'EHR').lines.join('\n');
    expect(list).toContain('1) ');
    expect(list).toMatch(/Rec #\d+/);

    const detail = handleInboundSms(PHONE, '1').lines.join('\n');
    expect(detail).toMatch(/Record #\d+/);
    expect(detail).toContain('Flu reviewed');
    expect(detail).toContain('Where: SMS Hospital');
    expect(detail).toContain('By: Dr. SMS');
    expect(detail).toMatch(/Visit receipt: RCPT-/);
    expect(detail).toContain('Notes: Rest advised.');
  });

  it('REC <number> opens a record directly', () => {
    const patient = getPatientByEmail('sms.patient@example.test')!;
    const rec = listEhrForPatient(patient.id)[0];
    const detail = handleInboundSms(PHONE, `REC ${rec.id}`).lines.join('\n');
    expect(detail).toContain(`Record #${rec.id}`);
    expect(detail).toContain('Flu reviewed');
  });

  it('EHR with many records offers a pick-a-type menu instead of a flat list', () => {
    const doctor = getStaffByEmail('doc@sms.dev')!;
    seedBusyPatient(HOSPITAL, doctor.id);

    const menu = handleInboundSms(BUSY_PHONE, 'EHR').lines.join('\n');
    expect(menu).toContain('You have 7 records. Pick a type:');
    expect(menu).toContain('Bones & joints (3)');
    expect(menu).toContain('Lab tests (2)');
    expect(menu).not.toContain('Wrist sprain'); // no specific injuries at this level

    // Types follow a fixed order: General, Orthopedic, Cardiac, ..., Laboratory.
    // Option 2 is Orthopedic -> lists only bone/joint records.
    const bones = handleInboundSms(BUSY_PHONE, '2').lines.join('\n');
    expect(bones).toContain('Bones & joints (3)');
    expect(bones).toContain('Wrist sprain');
    expect(bones).not.toContain('Blood panel');

    // Then a number opens one of those records.
    const detail = handleInboundSms(BUSY_PHONE, '1').lines.join('\n');
    expect(detail).toMatch(/Record #\d+/);
    expect(detail).toContain('Type: Bones & joints');
  });

  it('EHR <type> filters by type in one text', () => {
    const doctor = getStaffByEmail('doc@sms.dev')!;
    seedBusyPatient(HOSPITAL, doctor.id);
    const labs = handleInboundSms(BUSY_PHONE, 'EHR LAB').lines.join('\n');
    expect(labs).toContain('Blood panel');
    expect(labs).toContain('Vitamin D');
    expect(labs).not.toContain('Wrist sprain');
  });

  it('a bare number with no list sent first gets a prompt, not data', () => {
    const r = handleInboundSms(PHONE, '1').lines.join('\n');
    expect(r).toContain('no list to choose from');
  });

  it('REC with another patient\'s record number is refused like a missing record', () => {
    const doctor = getStaffByEmail('doc@sms.dev')!;
    const busy = seedBusyPatient(HOSPITAL, doctor.id);
    const theirRecord = listEhrForPatient(busy.id)[0];

    const r = handleInboundSms(PHONE, `REC ${theirRecord.id}`).lines.join('\n');
    expect(r).toContain('was not found in your records');
    expect(r).not.toContain(theirRecord.title);
  });

  it('menus are per phone: one patient\'s list cannot be used from another phone', () => {
    const doctor = getStaffByEmail('doc@sms.dev')!;
    seedBusyPatient(HOSPITAL, doctor.id);
    handleInboundSms(PHONE, 'EHR'); // Sam's list
    const r = handleInboundSms(BUSY_PHONE, '1').lines.join('\n'); // Bo replies "1" without his own list
    expect(r).toContain('no list to choose from');
    expect(r).not.toContain('Flu reviewed');
  });

  it('MEDS returns the active medication plan with a restock hint', () => {
    const r = handleInboundSms(PHONE, 'MEDS');
    const text = r.lines.join('\n');
    expect(text).toContain('Paracetamol');
    expect(text.toLowerCase()).toContain('restock');
  });

  it('PHARMACY lists nearby pharmacies with stock', () => {
    const r = handleInboundSms(PHONE, 'PHARMACY');
    const text = r.lines.join('\n');
    expect(text).toContain('SMS Pharmacy');
    expect(text).toContain('Paracetamol');
  });

  it('HOSPITAL lists nearby hospitals', () => {
    const r = handleInboundSms(PHONE, 'HOSPITAL');
    expect(r.lines.join('\n')).toContain('SMS Hospital');
  });

  it('APPT returns upcoming appointments', () => {
    const r = handleInboundSms(PHONE, 'APPT');
    expect(r.lines.join('\n')).toContain('Follow-up');
  });

  it('an unknown number gets a privacy-safe reply, not data', () => {
    const r = handleInboundSms('+19999999999', 'EHR');
    const text = r.lines.join('\n');
    expect(text).not.toContain('Flu reviewed');
    expect(text.toLowerCase()).toContain('not linked');
  });

  it('an unrecognized command is rejected gracefully', () => {
    const r = handleInboundSms(PHONE, 'DROP TABLE');
    expect(r.lines.join('\n').toLowerCase()).toContain('not a command');
  });

  it('serves the simulator web UI and answers the /sms API', async () => {
    const app = createSmsApp();
    const page = await request(app).get('/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('SMS Simulator');

    const api = await request(app).post('/sms').send({ from: PHONE, body: 'MEDS' });
    expect(api.status).toBe(200);
    expect(api.body.reply.join('\n')).toContain('Paracetamol');
  });
});
