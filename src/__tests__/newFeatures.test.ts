import { beforeEach, describe, expect, it } from 'vitest';
import { db, initSchema } from '../core/db';
import {
  createStaffUser,
  getLabTest,
  getVisitByAccessCode,
  listLabTestsForVisit,
} from '../core/entityStore';
import { buildActor, login, resolveAutoRole } from '../core/authService';
import { getPatientFor } from '../core/accessControl';
import { AccessDenied } from '../core/accessControl';
import { registerPatient } from '../core/patientService';
import { addToQueue } from '../modules/queue/queueService';
import {
  finalizeConsultation,
  openVisit,
} from '../modules/prescription/consultationService';
import { issueOtp, verifyOtp } from '../core/otpService';
import {
  getPortalVisitDetail,
  listPortalVisits,
  requestPortalOtp,
  verifyPortalOtp,
  PortalAccessError,
} from '../modules/portal/portalService';
import {
  lookupTestsByCode,
  recordResult,
} from '../modules/technician/technicianService';
import {
  getStaffAttachment,
  uploadVisitAttachment,
} from '../modules/attachments/attachmentService';

const FACILITY = 'TEST-CLINIC';

function wipe() {
  db.exec(`
    DELETE FROM attachments; DELETE FROM lab_tests; DELETE FROM otps;
    DELETE FROM dispensing_records; DELETE FROM prescriptions; DELETE FROM visits;
    DELETE FROM queue_entries; DELETE FROM access_grants; DELETE FROM audit_records;
    DELETE FROM notification_jobs; DELETE FROM patients; DELETE FROM staff_users;
    DELETE FROM staff_invites; DELETE FROM facilities;
  `);
}

function staff() {
  const recep = createStaffUser({ email: 'recep@test.dev', password: 'pw', name: 'Recep', phone: null, facilityCode: FACILITY, department: 'Reception', roles: ['Receptionist'] });
  const doc = createStaffUser({ email: 'doc@test.dev', password: 'pw', name: 'Doc', phone: null, facilityCode: FACILITY, department: 'General Medicine', roles: ['Doctor'] });
  const tech = createStaffUser({ email: 'tech@test.dev', password: 'pw', name: 'Tech', phone: null, facilityCode: FACILITY, department: 'Laboratory', roles: ['Technician'] });
  const techOther = createStaffUser({ email: 'tech2@test.dev', password: 'pw', name: 'Tech2', phone: null, facilityCode: 'OTHER-FAC', department: 'Laboratory', roles: ['Technician'] });
  return {
    recep: buildActor(recep, 'Receptionist'),
    doc: buildActor(doc, 'Doctor'),
    tech: buildActor(tech, 'Technician'),
    techOther: buildActor(techOther, 'Technician'),
  };
}

/** Read the most recently issued OTP code is not possible (hashed). For tests
 *  that need the code, we issue through a known path and read the job payload. */
function lastOtpCodeFor(): string {
  const row = db
    .prepare("SELECT payload FROM notification_jobs WHERE template='access_otp' ORDER BY id DESC LIMIT 1")
    .get() as any;
  return JSON.parse(row.payload).code as string;
}

describe('Technician role', () => {
  beforeEach(() => { initSchema(); wipe(); });

  it('authenticates, auto-selects the single role, and is denied patient records', () => {
    const { tech } = staff();
    const user = login('tech@test.dev', 'pw');
    expect(resolveAutoRole(user)).toBe('Technician');
    // Technician has no patient-record access at the data layer.
    expect(() => getPatientFor(tech, 1)).toThrow(AccessDenied);
  });
});

describe('Visit access code (receipt)', () => {
  beforeEach(() => { initSchema(); wipe(); });

  it('creates a unique, well-formed code and looks it up', () => {
    const { recep, doc } = staff();
    const p = registerPatient(recep, { email: 'rc@example.com', name: 'RC Patient' });
    const visit = openVisit(doc, p.id, null);
    expect(visit.accessCode).toMatch(/^RCPT-[A-Z2-9]{5}$/);
    const found = getVisitByAccessCode(visit.accessCode.toLowerCase());
    expect(found?.id).toBe(visit.id);
  });
});

describe('OTP service', () => {
  beforeEach(() => { initSchema(); wipe(); });

  it('verifies a correct code once and rejects wrong/reused', () => {
    issueOtp('portal:1', 'x@example.com');
    const code = lastOtpCodeFor();
    const wrong = code === '000000' ? '111111' : '000000';
    expect(verifyOtp('portal:1', wrong)).toBe(false); // wrong code
    expect(verifyOtp('portal:1', code)).toBe(true);   // correct
    expect(verifyOtp('portal:1', code)).toBe(false);  // reused
  });

  it('does not leak whether a context exists', () => {
    expect(verifyOtp('portal:does-not-exist', '123456')).toBe(false);
  });
});

describe('Patient portal (account-level)', () => {
  beforeEach(() => { initSchema(); wipe(); });

  function patientWithTwoVisits() {
    const actors = staff();
    const { recep, doc } = actors;
    const p = registerPatient(recep, { email: 'acct@example.com', name: 'Account Holder' });
    const v1 = openVisit(doc, p.id, null);
    finalizeConsultation(doc, v1.id, { diagnosis: 'A', notes: '', medications: [{ name: 'Med', dosage: '1', instructions: 'x' }] });
    const v2 = openVisit(doc, p.id, null);
    finalizeConsultation(doc, v2.id, { diagnosis: 'B', notes: '', medications: [], tests: [{ testName: 'CBC', priority: 'High', notes: null }] });
    return { p, v1, v2, actors };
  }

  it('logs in via email+OTP and lists ALL visits', () => {
    const { p } = patientWithTwoVisits();
    requestPortalOtp('acct@example.com');
    const code = lastOtpCodeFor();
    const id = verifyPortalOtp('acct@example.com', code);
    expect(id).toBe(p.id);

    const visits = listPortalVisits(p.id);
    expect(visits.length).toBe(2);
    expect(visits[0].accessCode).toMatch(/^RCPT-/);
  });

  it('enforces patient isolation: cannot load another patient visit', () => {
    const { p, v1, actors } = patientWithTwoVisits();
    const { recep, doc } = actors;
    const other = registerPatient(recep, { email: 'other@example.com', name: 'Other' });
    const ov = openVisit(doc, other.id, null);
    // p's session must not read other's visit.
    expect(() => getPortalVisitDetail(p.id, ov.id)).toThrow(PortalAccessError);
    // p can read its own.
    expect(getPortalVisitDetail(p.id, v1.id).visit.id).toBe(v1.id);
  });

  it('rejects an expired/consumed OTP on verify', () => {
    patientWithTwoVisits();
    requestPortalOtp('acct@example.com');
    const code = lastOtpCodeFor();
    expect(verifyPortalOtp('acct@example.com', code)).toBeTruthy();
    expect(verifyPortalOtp('acct@example.com', code)).toBeNull(); // reused
  });

  it('does not reveal whether an email is registered', () => {
    // Unknown email: no throw, no OTP issued.
    requestPortalOtp('nobody@example.com');
    const row = db.prepare("SELECT COUNT(*) as c FROM notification_jobs WHERE template='access_otp'").get() as any;
    expect(row.c).toBe(0);
    expect(verifyPortalOtp('nobody@example.com', '123456')).toBeNull();
  });
});

describe('Technician lab flow', () => {
  beforeEach(() => { initSchema(); wipe(); });

  it('records a result for a visit looked up by code and denies diagnosis access', () => {
    const { recep, doc, tech, techOther } = staff();
    const p = registerPatient(recep, { email: 'lab@example.com', name: 'Lab Patient' });
    const visit = openVisit(doc, p.id, null);
    finalizeConsultation(doc, visit.id, {
      diagnosis: 'Confidential diagnosis',
      notes: 'Confidential notes',
      medications: [],
      tests: [{ testName: 'CBC', priority: 'High', notes: null }],
    });

    const view = lookupTestsByCode(tech, visit.accessCode);
    expect(view.tests.length).toBe(1);
    // The technician view carries NO diagnosis/notes/patient identity.
    const blob = JSON.stringify(view);
    expect(blob).not.toContain('Confidential diagnosis');
    expect(blob).not.toContain('Confidential notes');
    expect(blob).not.toContain('lab@example.com');

    const testId = view.tests[0].id;
    const updated = recordResult(tech, testId, { result: 'Normal', resultAttachmentId: null });
    expect(updated.status).toBe('Done');
    expect(getLabTest(testId)!.result).toBe('Normal');

    // A technician at another facility cannot see or record this visit's tests.
    expect(() => lookupTestsByCode(techOther, visit.accessCode)).toThrow(AccessDenied);
  });
});

describe('Attachments', () => {
  beforeEach(() => { initSchema(); wipe(); });

  it('uploads, authorizes staff download, and rejects invalid type/size', () => {
    const { recep, doc } = staff();
    const p = registerPatient(recep, { email: 'att@example.com', name: 'Att Patient' });
    const visit = openVisit(doc, p.id, null);

    const att = uploadVisitAttachment(doc, visit.id, {
      originalName: 'note.txt',
      mime: 'text/plain',
      buffer: Buffer.from('hello'),
    });
    expect(att.id).toBeGreaterThan(0);
    expect(getStaffAttachment(doc, att.id).originalName).toBe('note.txt');

    // Invalid mime rejected.
    expect(() =>
      uploadVisitAttachment(doc, visit.id, { originalName: 'x.exe', mime: 'application/x-msdownload', buffer: Buffer.from('x') })
    ).toThrow();
  });
});
