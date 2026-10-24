import { db, initSchema } from './core/db';
import {
  createAttachment,
  createBed,
  createEquipment,
  createLabTest,
  createPatient,
  createPrescription,
  createStaffUser,
  createVisit,
  finalizeVisit,
  getPatientByEmail,
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

/**
 * Seed synthetic demo data and staff logins. NO REAL PII. Safe to re-run:
 * it clears the tables first (children before parents for foreign keys).
 */
export const RESET_SQL = `
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
    DELETE FROM equipment;
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

  const FACILITY = 'RURAL-CLINIC-01';
  const PHARMACY = 'PHARM-01';
  const PHARMACY2 = 'PHARM-02';

  // Facilities: one hospital, two pharmacies (public directory + price comparison).
  upsertFacility({
    code: FACILITY,
    name: 'Rural Clinic 01',
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

  // Equipment inventory with mixed statuses and their rooms.
  const equipmentPlan: Array<{ name: string; room: string; status: any }> = [
    { name: 'Ventilator', room: 'ER-1', status: 'InUse' },
    { name: 'Defibrillator', room: 'ER-1', status: 'Operational' },
    { name: 'ECG monitor', room: 'ER-2', status: 'Operational' },
    { name: 'X-ray machine', room: 'R-103', status: 'Maintenance' },
    { name: 'Infusion pump', room: 'R-101', status: 'Operational' },
    { name: 'Ultrasound scanner', room: 'R-102', status: 'Broken' },
  ];
  for (const e of equipmentPlan) {
    createEquipment({ facilityCode: FACILITY, name: e.name, room: e.room, status: e.status });
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
  createInsurancePlan({ name: 'Rural Essentials', provider: 'Sample Health Co-op', monthlyPremiumCents: 300, coveragePercent: 30, description: 'Low-cost cover for essential care.' });

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
  createEquipment({ facilityCode: FACILITY, name: 'Portable X-ray', category: 'Orthopedic', location: 'Orthopedics', status: 'Operational' });
  createEquipment({ facilityCode: FACILITY, name: 'ECG machine', category: 'Cardiac', location: 'General Medicine', status: 'Maintenance' });
  createEquipment({ facilityCode: FACILITY, name: 'Hematology analyzer', category: 'Laboratory', location: 'Laboratory', status: 'InUse' });
  createEquipment({ facilityCode: FACILITY, name: 'Oxygen concentrator', category: 'General', location: 'Ward A', status: 'Operational' });
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

  // Occupancy demo: two OPEN visits assigned to beds, so the receptionist's
  // availability board shows which patient + doctor is at which bed/room. These
  // visits are left Open (not finalized) so they count as current occupancy.
  const mina = getPatientByEmail('mina.patient@example.test')!;
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

  // eslint-disable-next-line no-console
  console.log('Seed complete. Demo logins (all password: demo1234):');
  for (const s of staff) {
    console.log(`  ${s.email.padEnd(24)} roles=${s.roles.join(',')}${'specialty' in s ? ` specialty=${s.specialty}` : ''}`);
  }
  console.log('Synthetic patients: Jordan Rivera (2 visits, insured, active plan), Mina Haddad');
  console.log(`Patient portal demo: open /portal, enter ${jordan.email}, use the OTP printed to this log.`);
  console.log(`Receipt codes for Jordan: ${v1.accessCode}, ${v2.accessCode}`);
  console.log(`Pharmacy token for Jordan's active plan: ${rx2.pharmacyLookupToken}`);
}

if (require.main === module) seed();
