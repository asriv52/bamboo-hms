import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db, initSchema } from '../core/db';
import { createApp } from '../transport/web/app';
import { createStaffUser, getPatientByEmail } from '../core/entityStore';

const FACILITY = 'WEB-CLINIC';

function wipe() {
  db.exec(`
    DELETE FROM attachments; DELETE FROM lab_tests; DELETE FROM otps;
    DELETE FROM dispensing_records; DELETE FROM prescriptions; DELETE FROM visits;
    DELETE FROM queue_entries; DELETE FROM access_grants; DELETE FROM audit_records;
    DELETE FROM notification_jobs; DELETE FROM patients; DELETE FROM staff_users;
    DELETE FROM staff_invites; DELETE FROM facilities;
  `);
}

function seedStaff() {
  createStaffUser({ email: 'recep@web.dev', password: 'pw', name: 'Recep', phone: null, facilityCode: FACILITY, department: 'Reception', roles: ['Receptionist'] });
  createStaffUser({ email: 'doc@web.dev', password: 'pw', name: 'Doc', phone: null, facilityCode: FACILITY, department: 'General Medicine', roles: ['Doctor'] });
  createStaffUser({ email: 'tech@web.dev', password: 'pw', name: 'Tech', phone: null, facilityCode: FACILITY, department: 'Laboratory', roles: ['Technician'] });
  createStaffUser({ email: 'admin@web.dev', password: 'pw', name: 'Admin', phone: null, facilityCode: FACILITY, department: 'Reception', roles: ['Admin'] });
  createStaffUser({ email: 'pharm@web.dev', password: 'pw', name: 'Pharm', phone: null, facilityCode: FACILITY, department: 'Pharmacy', roles: ['Pharmacy'] });
}

/** Log in via the web and return an agent with the session cookie set. */
async function loginAs(email: string) {
  const agent = request.agent(createApp());
  const res = await agent.post('/login').type('form').send({ email, password: 'pw' });
  // Single-role accounts auto-select and redirect to /dashboard.
  expect([302, 303]).toContain(res.status);
  return agent;
}

function lastOtpCode(): string {
  const row = db
    .prepare("SELECT payload FROM notification_jobs WHERE template='access_otp' ORDER BY id DESC LIMIT 1")
    .get() as any;
  return JSON.parse(row.payload).code as string;
}

describe('Web dashboards render per role', () => {
  beforeEach(() => { initSchema(); wipe(); seedStaff(); });

  it('renders the role dashboards and technician/portal pages', async () => {
    const doc = await loginAs('doc@web.dev');
    const docDash = await doc.get('/dashboard');
    expect(docDash.status).toBe(200);
    expect(docDash.text).toContain('Quick actions');

    const tech = await loginAs('tech@web.dev');
    const techPage = await tech.get('/technician');
    expect(techPage.status).toBe(200);
    expect(techPage.text).toContain('Lab tests');

    const admin = await loginAs('admin@web.dev');
    const adminDash = await admin.get('/dashboard');
    expect(adminDash.status).toBe(200);

    // Portal login page is public.
    const portal = await request(createApp()).get('/portal');
    expect(portal.status).toBe(200);
    expect(portal.text).toContain('View your health records');
  });

  it('blocks a technician from a doctor-only page', async () => {
    const tech = await loginAs('tech@web.dev');
    const res = await tech.get('/patients');
    expect(res.status).toBe(403);
  });
});

describe('End-to-end: register -> consult (test+file) -> technician -> portal', () => {
  beforeEach(() => { initSchema(); wipe(); seedStaff(); });

  it('walks the full expanded flow', async () => {
    const recep = await loginAs('recep@web.dev');
    const doc = await loginAs('doc@web.dev');
    const tech = await loginAs('tech@web.dev');

    // 1. Register a patient via the web.
    const reg = await recep
      .post('/patients')
      .type('form')
      .send({ email: 'e2e@example.com', name: 'E2E Patient' });
    expect([302, 303]).toContain(reg.status);
    const patient = getPatientByEmail('e2e@example.com')!;
    expect(patient).toBeTruthy();

    // 2. Queue the patient. Use the web endpoint so the whole flow is exercised.
    const qRes = await recep
      .post('/queue')
      .type('form')
      .send({ patientId: String(patient.id), department: 'General Medicine' });
    expect([302, 303]).toContain(qRes.status);
    const entry = db
      .prepare('SELECT * FROM queue_entries WHERE patient_id=? ORDER BY id DESC LIMIT 1')
      .get(patient.id) as any;

    const open = await doc
      .post('/visits')
      .type('form')
      .send({ patientId: String(patient.id), queueEntryId: String(entry.id) });
    expect([302, 303]).toContain(open.status);
    const location = open.headers['location'] as string;
    const visitId = Number(location.split('/visits/')[1].split('?')[0]);

    // 3. Finalize with a medication, a recommended test, and a diagnosis.
    const fin = await doc
      .post(`/visits/${visitId}/finalize`)
      .type('form')
      .send({
        diagnosis: 'E2E diagnosis',
        notes: 'E2E notes',
        medName: 'Amoxicillin',
        medDosage: '500mg',
        medInstructions: 'Twice daily',
        testName: 'Complete Blood Count',
        testPriority: 'High',
        testNotes: '',
      });
    expect([302, 303]).toContain(fin.status);

    const visit = db.prepare('SELECT * FROM visits WHERE id=?').get(visitId) as any;
    const accessCode = visit.access_code as string;
    expect(accessCode).toMatch(/^RCPT-/);

    // 4. Doctor attaches a file to the visit.
    const up = await doc
      .post(`/visits/${visitId}/attachments`)
      .field('patientId', String(patient.id))
      .attach('file', Buffer.from('lab referral'), { filename: 'ref.txt', contentType: 'text/plain' });
    expect([302, 303]).toContain(up.status);

    // 5. Technician looks up the visit by code and records the test result.
    const techView = await tech.get(`/technician?code=${accessCode}`);
    expect(techView.status).toBe(200);
    expect(techView.text).toContain('Complete Blood Count');
    const testRow = db.prepare('SELECT id FROM lab_tests WHERE visit_id=?').get(visitId) as any;
    const result = await tech
      .post(`/technician/tests/${testRow.id}/result`)
      .field('code', accessCode)
      .field('result', 'All normal');
    expect([302, 303]).toContain(result.status);

    // 6. Patient logs into the portal (account-level) by email + OTP.
    const portal = request.agent(createApp());
    const reqOtp = await portal.post('/portal/request-otp').type('form').send({ email: 'e2e@example.com' });
    expect([302, 303]).toContain(reqOtp.status);
    const code = lastOtpCode();
    const verify = await portal.post('/portal/verify').type('form').send({ email: 'e2e@example.com', code });
    expect([302, 303]).toContain(verify.status);

    const home = await portal.get('/portal/home');
    expect(home.status).toBe(200);
    expect(home.text).toContain(accessCode); // the visit/receipt appears in their history

    const detail = await portal.get(`/portal/visits/${visitId}`);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain('E2E diagnosis');
    expect(detail.text).toContain('Amoxicillin');
    expect(detail.text).toContain('All normal'); // technician result visible to patient
    expect(detail.text).toContain('ref.txt');    // attachment visible to patient
  });
});
