import { db, initSchema } from './core/db';
import {
  createAttachment,
  createBed,
  createGrant,
  createLabTest,
  createPatient,
  createPrescription,
  createStaffUser,
  createVisit,
  finalizeVisit,
  getStaffByEmail,
  listBedsByFacility,
  recordLabTestResult,
  updateBedStatus,
  upsertFacility,
} from './core/entityStore';
import { assignTechnician, createAppointment, createEhrRecord } from './core/careStore';
import {
  createInsurancePlan,
  createServicePrice,
  insertCharge,
  setPatientInsurance,
  upsertStock,
} from './core/commerceStore';
import {
  createEquipment,
  createRoom,
  createShift,
  setPatientAccommodations,
  upsertFacilityAccommodation,
} from './core/opsStore';
import { randomToken } from './core/crypto';
import { saveBytes } from './core/fileStore';
import {
  createWearableConsent,
  getOrCreatePseudonym,
  markWearableSynced,
  saveWearableConnection,
  upsertWearableObservations,
} from './core/wearableStore';
import { simulateWhoopDailyRecords, SimulatedProfile } from './modules/wearables/whoopClient';
import {
  CONSENT_TEXT_SHA256,
  CONSENT_VERSION,
  WEARABLE_PROVIDER,
} from './modules/wearables/wearableService';

/**
 * Seed synthetic demo data and staff logins. NO REAL PII. Safe to re-run:
 * it clears the tables first (children before parents for foreign keys).
 */
export const RESET_SQL = `
    DELETE FROM wearable_observations;
    DELETE FROM wearable_reid_vault;
    DELETE FROM wearable_connections;
    DELETE FROM wearable_consents;
    DELETE FROM charges;
    DELETE FROM patient_insurance;
    DELETE FROM insurance_plans;
    DELETE FROM service_prices;
    DELETE FROM pharmacy_stock;
    DELETE FROM appointments;
    DELETE FROM technician_assignments;
    DELETE FROM ehr_records;
    DELETE FROM patient_accommodations;
    DELETE FROM facility_accommodations;
    DELETE FROM rooms;
    DELETE FROM equipment;
    DELETE FROM staff_shifts;
    DELETE FROM attachments;
    DELETE FROM lab_tests;
    DELETE FROM otps;
    DELETE FROM dispensing_records;
    DELETE FROM prescriptions;
    DELETE FROM visits;
    DELETE FROM queue_entries;
    DELETE FROM access_grants;
    DELETE FROM audit_records;
    DELETE FROM notification_jobs;
    DELETE FROM beds;
    DELETE FROM patients;
    DELETE FROM staff_users;
    DELETE FROM staff_invites;
    DELETE FROM facilities;
`;

function reset(): void {
  db.exec(RESET_SQL);
}

const daysFromNow = (d: number, hourUtc = 9) => {
  const t = new Date(Date.now() + d * 86400_000);
  t.setUTCHours(hourUtc, 0, 0, 0);
  return t.toISOString();
};

function seed(): void {
  initSchema();
  reset();

  const FACILITY = 'CLINIC-01';
  const PHARMACY = 'PHARM-01';
  const PHARMACY2 = 'PHARM-02';

  // Facilities: one hospital, two pharmacies (public directory + price comparison).
  upsertFacility({
    code: FACILITY,
    name: 'Community Clinic 01',
    kind: 'Hospital',
    address: '1 Clinic Rd, Demo Town',
    phone: '+15550000000',
    operatingHours: 'Mon–Sat 08:00–18:00, emergencies 24/7',
    departments: ['Reception', 'General Medicine', 'Pediatrics', 'Laboratory', 'Orthopedics', 'Pharmacy'],
    specialties: 'General medicine, maternal health, basic pediatrics, orthopedics',
  });
  upsertFacility({
    code: PHARMACY,
    name: 'Community Pharmacy 01',
    kind: 'Pharmacy',
    address: '2 Market St, Demo Town',
    phone: '+15550000001',
    operatingHours: 'Mon–Sun 07:00–21:00',
    departments: ['Pharmacy'],
    specialties: 'Dispensing, restock',
  });

  // Beds / rooms for the seat-map availability view. Two wards: Regular and
  // Emergency, each with a few rooms of beds in mixed statuses so the demo
  // shows the full legend.
  const bedPlan: Array<{ ward: string; room: string; label: string; status: any }> = [
    { ward: 'Regular', room: 'R-101', label: 'A', status: 'Available' },
    { ward: 'Regular', room: 'R-101', label: 'B', status: 'Occupied' },
    { ward: 'Regular', room: 'R-101', label: 'C', status: 'Available' },
    { ward: 'Regular', room: 'R-102', label: 'A', status: 'Reserved' },
    { ward: 'Regular', room: 'R-102', label: 'B', status: 'Cleaning' },
    { ward: 'Regular', room: 'R-103', label: 'A', status: 'Available' },
    { ward: 'Regular', room: 'R-103', label: 'B', status: 'OutOfService' },
    { ward: 'Emergency', room: 'ER-1', label: 'A', status: 'Occupied' },
    { ward: 'Emergency', room: 'ER-1', label: 'B', status: 'Available' },
    { ward: 'Emergency', room: 'ER-2', label: 'A', status: 'Available' },
    { ward: 'Emergency', room: 'ER-2', label: 'B', status: 'Reserved' },
  ];
  for (const b of bedPlan) {
    createBed({ facilityCode: FACILITY, ward: b.ward, room: b.room, label: b.label, status: b.status });
  }
  // Keyed lookup so we can assign demo visits to specific beds below.
  const bedByKey = new Map(
    listBedsByFacility(FACILITY).map((b) => [`${b.room}-${b.label}`, b])
  );

  // Equipment inventory. Category drives technician specialty scoping;
  // location is the room label so the receptionist board can link equipment
  // to the patients in that room.
  const equipmentPlan: Array<{ name: string; category: string; room: string; status: any }> = [
    { name: 'Ventilator', category: 'General', room: 'ER-1', status: 'InUse' },
    { name: 'Defibrillator', category: 'Cardiac', room: 'ER-1', status: 'Operational' },
    { name: 'ECG monitor', category: 'Cardiac', room: 'ER-2', status: 'Operational' },
    { name: 'X-ray machine', category: 'Orthopedic', room: 'R-103', status: 'Maintenance' },
    { name: 'Infusion pump', category: 'General', room: 'R-101', status: 'Operational' },
    { name: 'Ultrasound scanner', category: 'General', room: 'R-102', status: 'OutOfService' },
    { name: 'Hematology analyzer', category: 'Laboratory', room: 'Laboratory', status: 'InUse' },
    { name: 'Oxygen concentrator', category: 'General', room: 'Ward A', status: 'Operational' },
  ];
  for (const e of equipmentPlan) {
    createEquipment({ facilityCode: FACILITY, name: e.name, category: e.category, location: e.room, room: e.room, status: e.status });
  }

  // Staff logins (synthetic). One multi-role account to demo role selection.
  const staff = [
    { email: 'admin@clinic.test', name: 'Ada Admin', roles: ['Admin'], facility: FACILITY, department: 'Reception' },
    { email: 'reception@clinic.test', name: 'Ravi Reception', roles: ['Receptionist'], facility: FACILITY, department: 'Reception' },
    { email: 'doctor@clinic.test', name: 'Dr. Dana Okafor', roles: ['Doctor'], facility: FACILITY, department: 'General Medicine', license: 'MD-SYN-1001' },
    { email: 'doctor2@clinic.test', name: 'Dr. Lee Mensah', roles: ['Doctor'], facility: FACILITY, department: 'Orthopedics', license: 'MD-SYN-1002' },
    { email: 'pharmacy@clinic.test', name: 'Priya Pharmacist', roles: ['Pharmacy'], facility: PHARMACY, department: 'Pharmacy', license: 'PH-SYN-2001' },
    { email: 'technician@clinic.test', name: 'Tomas Technician', roles: ['Technician'], facility: FACILITY, department: 'Laboratory', specialty: 'Laboratory', license: 'TC-SYN-3001' },
    { email: 'bonetech@clinic.test', name: 'Bea Bone-Tech', roles: ['Technician'], facility: FACILITY, department: 'Orthopedics', specialty: 'Orthopedic', license: 'TC-SYN-3002' },
    { email: 'multi@clinic.test', name: 'Sam Multi', roles: ['Doctor', 'Receptionist'], facility: FACILITY, department: 'Pediatrics' },
  ] as const;

  for (const s of staff) {
    createStaffUser({
      email: s.email,
      password: 'demo1234',
      name: s.name,
      phone: null,
      facilityCode: s.facility,
      department: s.department,
      roles: s.roles as any,
      specialty: 'specialty' in s ? (s.specialty as any) : null,
      licenseNumber: 'license' in s ? s.license : null,
    });
  }
  const doctor = getStaffByEmail('doctor@clinic.test')!;
  const doctor2 = getStaffByEmail('doctor2@clinic.test')!;
  const boneTech = getStaffByEmail('bonetech@clinic.test')!;

  // Insurance marketplace + published estimates + pharmacy stock.
  const basic = createInsurancePlan({ name: 'Community Basic', provider: 'Demo Mutual', monthlyPremiumCents: 800, coveragePercent: 50, description: 'Covers half of clinic and pharmacy bills.' });
  createInsurancePlan({ name: 'Family Plus', provider: 'Demo Mutual', monthlyPremiumCents: 2500, coveragePercent: 80, description: 'Covers 80% for the whole household.' });
  createInsurancePlan({ name: 'Basic Essentials', provider: 'Sample Health Co-op', monthlyPremiumCents: 300, coveragePercent: 30, description: 'Low-cost cover for essential care.' });

  createServicePrice({ facilityCode: FACILITY, serviceName: 'Consultation', condition: 'General visit', estimatedCents: 1500 });
  createServicePrice({ facilityCode: FACILITY, serviceName: 'Complete Blood Count', condition: 'Anemia / infection screening', estimatedCents: 800 });
  createServicePrice({ facilityCode: FACILITY, serviceName: 'X-ray (single view)', condition: 'Suspected fracture', estimatedCents: 3000 });
  createServicePrice({ facilityCode: FACILITY, serviceName: 'Malaria treatment course', condition: 'Malaria', estimatedCents: 1200 });

  upsertStock({ pharmacyCode: PHARMACY, medicationName: 'Paracetamol', quantity: 400, unitPriceCents: 10, supplier: 'Synthetic Pharma Ltd' });
  upsertStock({ pharmacyCode: PHARMACY, medicationName: 'Amoxicillin', quantity: 120, unitPriceCents: 35, supplier: 'Demo Generics' });
  upsertStock({ pharmacyCode: PHARMACY, medicationName: 'Ferrous Sulfate', quantity: 15, unitPriceCents: 8, supplier: 'Demo Generics' });
  upsertStock({ pharmacyCode: PHARMACY2, medicationName: 'Paracetamol', quantity: 0, unitPriceCents: 8, supplier: 'Sample Supply Co' });
  upsertStock({ pharmacyCode: PHARMACY2, medicationName: 'Ibuprofen', quantity: 200, unitPriceCents: 12, supplier: 'Sample Supply Co' });

  // Hospital operations: rooms, equipment, accommodations, shifts.
  createRoom({ facilityCode: FACILITY, name: 'Exam 1', roomType: 'Exam', status: 'Available' });
  createRoom({ facilityCode: FACILITY, name: 'Exam 2', roomType: 'Exam', status: 'Occupied' });
  createRoom({ facilityCode: FACILITY, name: 'Ward A', roomType: 'Ward', status: 'Cleaning' });
  upsertFacilityAccommodation({ facilityCode: FACILITY, accommodation: 'Wheelchair access', capacity: 4, inUse: 1 });
  upsertFacilityAccommodation({ facilityCode: FACILITY, accommodation: 'Language translator', capacity: 2, inUse: 2 });
  upsertFacilityAccommodation({ facilityCode: FACILITY, accommodation: 'Ground-floor access', capacity: 10, inUse: 3 });
  upsertFacilityAccommodation({ facilityCode: PHARMACY, accommodation: 'Wheelchair access', capacity: 1, inUse: 0 });
  for (const s of staff.filter((x) => x.facility === FACILITY)) {
    const u = getStaffByEmail(s.email)!;
    for (const day of [1, 2, 3, 4, 5]) {
      createShift({ staffId: u.id, facilityCode: FACILITY, dayOfWeek: day, startTime: '08:00', endTime: '16:00' });
    }
  }

  // Synthetic patients.
  const jordan = createPatient({
    email: 'jordan.patient@example.test',
    name: 'Jordan Rivera',
    phone: '+15550100001',
    nationalId: 'SYN-0001',
    address: '12 Example Rd, Demo Town',
    bloodType: 'O+',
    allergies: 'Penicillin',
  });
  const mina = createPatient({
    email: 'mina.patient@example.test',
    name: 'Mina Haddad',
    phone: '+15550100002',
    nationalId: 'SYN-0002',
    address: '7 Sample St, Demo Town',
    bloodType: 'A-',
    allergies: null,
  });
  setPatientInsurance({ patientId: jordan.id, planId: basic.id, memberId: 'SYN-MEMBER-0001' });
  setPatientAccommodations(jordan.id, ['Wheelchair access']);

  // Visit 1: finalized with a prescription + an attachment + a consultation bill.
  const v1 = createVisit({ patientId: jordan.id, doctorId: doctor.id, queueEntryId: null, facilityCode: FACILITY });
  finalizeVisit(v1.id, 'Seasonal flu', 'Rest, fluids, review in one week.');
  createPrescription({
    visitId: v1.id,
    patientId: jordan.id,
    medications: [{ name: 'Paracetamol', dosage: '500mg', instructions: 'Every 6 hours as needed', daysSupply: 7 }],
    pharmacyLookupToken: randomToken(),
  });
  const noteBytes = Buffer.from('Synthetic demo attachment: discharge note for visit ' + v1.accessCode + '.\n', 'utf8');
  const stored = saveBytes(noteBytes, 'text/plain');
  createAttachment({ visitId: v1.id, originalName: 'discharge-note.txt', storedName: stored, mime: 'text/plain', size: noteBytes.length, uploadedByRole: 'Doctor' });
  insertCharge({
    patientId: jordan.id, facilityCode: FACILITY, source: 'Visit', sourceId: v1.id,
    description: 'Consultation', amountCents: 1500, insuranceCents: 750, patientCents: 750,
    referringFacilityCode: null, status: 'Paid',
  });

  // Visit 2: finalized with tests (one done) and the current active plan.
  const v2 = createVisit({ patientId: jordan.id, doctorId: doctor.id, queueEntryId: null, facilityCode: FACILITY });
  finalizeVisit(v2.id, 'Fatigue — rule out anemia', 'Ordered blood work.');
  createLabTest({ visitId: v2.id, testName: 'Complete Blood Count', priority: 'High', notes: 'Fasting not required.' });
  const doneTest = createLabTest({ visitId: v2.id, testName: 'Iron Panel', priority: 'Medium', notes: null });
  recordLabTestResult(doneTest.id, 'Within normal range.', null);
  // Current active medication plan from visit 2 (used for the pharmacy token demo).
  const rx2 = createPrescription({
    visitId: v2.id,
    patientId: jordan.id,
    medications: [{ name: 'Ferrous Sulfate', dosage: '200mg', instructions: 'Once daily with food', daysSupply: 30 }],
    pharmacyLookupToken: randomToken(),
  });

  // EHR records + appointments so the patient SMS simulator has content to
  // return for the EHR and APPT commands. Synthetic only.
  createEhrRecord({
    patientId: jordan.id, visitId: v1.id, facilityCode: FACILITY, category: 'General',
    title: 'Seasonal flu — reviewed', content: 'Rest and fluids advised. Follow up in one week.',
    authorId: doctor.id,
  });
  createEhrRecord({
    patientId: jordan.id, visitId: v2.id, facilityCode: FACILITY, category: 'Laboratory',
    title: 'Blood work ordered (anemia screen)', content: 'CBC and iron panel requested.',
    authorId: doctor.id,
  });
  createEhrRecord({
    patientId: jordan.id, visitId: null, facilityCode: FACILITY, category: 'Radiology',
    title: 'Chest X-ray — clear', content: 'No acute findings.',
    authorId: doctor.id,
  });
  // Mina has more than 5 records, so texting EHR from her phone shows the
  // pick-a-type menu instead of a flat list.
  const minaRecords: Array<{ category: any; title: string; content: string }> = [
    { category: 'Orthopedic', title: 'Wrist sprain follow-up', content: 'Healing well; continue support brace.' },
    { category: 'Orthopedic', title: 'Wrist sprain — initial exam', content: 'Grade 1 sprain, brace fitted, rest 2 weeks.' },
    { category: 'Orthopedic', title: 'Knee pain assessment', content: 'Mild strain after a fall. Ice and rest advised.' },
    { category: 'Radiology', title: 'Wrist X-ray — no fracture', content: 'No fracture seen. Soft tissue swelling only.' },
    { category: 'Laboratory', title: 'Routine blood panel', content: 'All values within normal range.' },
    { category: 'Laboratory', title: 'Vitamin D level', content: 'Slightly low. Supplement recommended.' },
    { category: 'Cardiac', title: 'ECG — routine screen', content: 'Normal sinus rhythm.' },
    { category: 'General', title: 'Annual check-up', content: 'Healthy. Blood pressure 118/76.' },
  ];
  for (const r of minaRecords) {
    createEhrRecord({
      patientId: mina.id, visitId: null, facilityCode: FACILITY, category: r.category,
      title: r.title, content: r.content, authorId: doctor2.id,
    });
  }

  createAppointment({
    patientId: jordan.id, doctorId: doctor.id, facilityCode: FACILITY,
    scheduledAt: daysFromNow(3, 10), reason: 'Flu follow-up',
  });
  createAppointment({
    patientId: jordan.id, doctorId: doctor2.id, facilityCode: FACILITY,
    scheduledAt: daysFromNow(14, 14), reason: 'Blood work review',
  });
  createAppointment({
    patientId: mina.id, doctorId: doctor2.id, facilityCode: FACILITY,
    scheduledAt: daysFromNow(5, 9), reason: 'Orthopedic check',
  });

  // Occupancy demo: two OPEN visits assigned to beds, so the receptionist's
  // availability board shows which patient + doctor is at which bed/room. These
  // visits are left Open (not finalized) so they count as current occupancy.
  // `mina` is already declared above with the other synthetic patients.
  const regBed = bedByKey.get('R-101-B'); // in the Regular ward
  const erBed = bedByKey.get('ER-1-A');   // in the Emergency ward
  if (regBed) {
    createVisit({ patientId: jordan.id, doctorId: doctor.id, queueEntryId: null, facilityCode: FACILITY, bedId: regBed.id });
    updateBedStatus(FACILITY, regBed.id, 'Occupied');
  }
  if (erBed) {
    createVisit({ patientId: mina.id, doctorId: doctor.id, queueEntryId: null, facilityCode: FACILITY, bedId: erBed.id });
    updateBedStatus(FACILITY, erBed.id, 'Occupied');
  }

  // Wearables (WHOOP, simulated) — dummy EHR + wearable test data.
  //   - Jordan: consent with research opt-in, 30 days, treated by Dr. Okafor.
  //   - Mina: NOT enrolled, to demo the portal sign-up flow.
  //   - A 12-patient synthetic cohort with distinct health profiles (normal,
  //     athletic, hypertensive, poor sleep, low recovery), each with a matching
  //     finalized visit + EHR entry. Most opted in to research; two share with
  //     doctors only, so the ML dataset visibly excludes them. Cohort patients
  //     are split between Dr. Okafor and Dr. Mensah so re-identification can be
  //     tested both ways (allowed for your own patient, denied for the other's).
  const WEARABLE_DAYS = 30;
  const enrollWearable = (
    patientId: number,
    name: string,
    allowResearch: boolean,
    profile: SimulatedProfile = 'typical'
  ) => {
    createWearableConsent({
      patientId, provider: WEARABLE_PROVIDER, consentVersion: CONSENT_VERSION,
      consentTextSha256: CONSENT_TEXT_SHA256, signatureName: name,
      shareWithDoctors: true, allowResearch,
    });
    const pseudonym = getOrCreatePseudonym(patientId);
    saveWearableConnection({ patientId, provider: WEARABLE_PROVIDER, mode: 'simulated', accessToken: null, refreshToken: null, tokenExpiresAt: null });
    upsertWearableObservations(pseudonym, 'WHOOP (simulated)', simulateWhoopDailyRecords(pseudonym, WEARABLE_DAYS, profile));
    markWearableSynced(patientId);
    return pseudonym;
  };
  const jordanCode = enrollWearable(jordan.id, jordan.name, true);

  const PROFILE_EHR: Record<SimulatedProfile, { diagnosis: string; category: any; title: string; content: string }> = {
    typical: { diagnosis: 'Routine check-up', category: 'General', title: 'Annual check-up', content: 'Healthy. Wearable vitals within normal range.' },
    athletic: { diagnosis: 'Sports physical', category: 'Cardiac', title: 'Athletic bradycardia — benign', content: 'Low resting HR consistent with training. ECG normal sinus rhythm.' },
    hypertensive: { diagnosis: 'Stage 1 hypertension', category: 'Cardiac', title: 'Hypertension — monitoring', content: 'Clinic BP 142/92. Lifestyle changes advised; review wearable BP trend in 4 weeks.' },
    poorSleep: { diagnosis: 'Insomnia', category: 'General', title: 'Sleep complaint', content: 'Reports poor sleep for 2 months. Sleep hygiene counselling; review wearable sleep data.' },
    lowRecovery: { diagnosis: 'Fatigue — under investigation', category: 'Laboratory', title: 'Fatigue work-up', content: 'Low HRV and recovery on wearable. CBC and thyroid panel ordered.' },
  };
  const cohort: Array<{ name: string; profile: SimulatedProfile; research: boolean; doctorId: number; blood: string }> = [
    { name: 'Avery Cohort', profile: 'typical', research: true, doctorId: doctor.id, blood: 'O+' },
    { name: 'Blake Cohort', profile: 'athletic', research: true, doctorId: doctor.id, blood: 'A+' },
    { name: 'Casey Cohort', profile: 'hypertensive', research: true, doctorId: doctor.id, blood: 'B+' },
    { name: 'Devon Cohort', profile: 'poorSleep', research: true, doctorId: doctor.id, blood: 'O-' },
    { name: 'Emery Cohort', profile: 'lowRecovery', research: true, doctorId: doctor.id, blood: 'AB+' },
    { name: 'Finley Cohort', profile: 'hypertensive', research: false, doctorId: doctor.id, blood: 'A-' },
    { name: 'Gray Cohort', profile: 'typical', research: true, doctorId: doctor2.id, blood: 'O+' },
    { name: 'Harper Cohort', profile: 'athletic', research: true, doctorId: doctor2.id, blood: 'B-' },
    { name: 'Indigo Cohort', profile: 'hypertensive', research: true, doctorId: doctor2.id, blood: 'A+' },
    { name: 'Jules Cohort', profile: 'poorSleep', research: true, doctorId: doctor2.id, blood: 'O+' },
    { name: 'Kai Cohort', profile: 'lowRecovery', research: true, doctorId: doctor2.id, blood: 'AB-' },
    { name: 'Logan Cohort', profile: 'typical', research: false, doctorId: doctor2.id, blood: 'B+' },
  ];
  const cohortCodes: Array<{ name: string; profile: SimulatedProfile; research: boolean; doctor: string; code: string }> = [];
  cohort.forEach((c, i) => {
    const n = String(i + 1).padStart(2, '0');
    const p = createPatient({
      email: `cohort.${c.name.split(' ')[0].toLowerCase()}@example.test`,
      name: c.name,
      phone: `+155501001${n}`,
      nationalId: `SYN-C${n}`,
      address: `${i + 20} Cohort Lane, Demo Town`,
      bloodType: c.blood,
      allergies: null,
    });
    const ehr = PROFILE_EHR[c.profile];
    const visit = createVisit({ patientId: p.id, doctorId: c.doctorId, queueEntryId: null, facilityCode: FACILITY });
    finalizeVisit(visit.id, ehr.diagnosis, 'Synthetic cohort visit for wearable / EHR testing.');
    createEhrRecord({
      patientId: p.id, visitId: visit.id, facilityCode: FACILITY, category: ehr.category,
      title: ehr.title, content: ehr.content, authorId: c.doctorId,
    });
    const code = enrollWearable(p.id, p.name, c.research, c.profile);
    cohortCodes.push({
      name: c.name, profile: c.profile, research: c.research,
      doctor: c.doctorId === doctor.id ? 'doctor@' : 'doctor2@', code,
    });
  });

  // eslint-disable-next-line no-console
  console.log('Seed complete. Demo logins (all password: demo1234):');
  for (const s of staff) {
    console.log(`  ${s.email.padEnd(24)} roles=${s.roles.join(',')}${'specialty' in s ? ` specialty=${s.specialty}` : ''}`);
  }
  console.log('Synthetic patients: Jordan Rivera (2 visits, insured, active plan), Mina Haddad');
  console.log(`Patient portal demo: open /portal, enter ${jordan.email}, use the OTP printed to this log.`);
  console.log(`Receipt codes for Jordan: ${v1.accessCode}, ${v2.accessCode}`);
  console.log(`Pharmacy token for Jordan's active plan: ${rx2.pharmacyLookupToken}`);
  console.log(`WHOOP (simulated): Jordan enrolled, research code ${jordanCode}; Mina not enrolled (demo sign-up at /portal/wearables).`);
  console.log(`Wearable cohort (${WEARABLE_DAYS} days each; research dataset at /research/wearables as a Doctor):`);
  for (const c of cohortCodes) {
    console.log(`  ${c.name.padEnd(14)} ${c.profile.padEnd(12)} treated by ${c.doctor.padEnd(9)} research=${c.research ? 'yes' : 'no '} ${c.code}`);
  }
}

if (require.main === module) seed();
