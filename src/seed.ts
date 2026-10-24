import { db, initSchema } from './core/db';
import {
  createPatient,
  createStaffUser,
  getStaffByEmail,
  upsertFacility,
} from './core/entityStore';

/**
 * Seed synthetic demo data and staff logins. NO REAL PII. Safe to re-run:
 * it clears the tables first.
 */
function reset(): void {
  db.exec(`
    DELETE FROM dispensing_records;
    DELETE FROM prescriptions;
    DELETE FROM visits;
    DELETE FROM queue_entries;
    DELETE FROM access_grants;
    DELETE FROM audit_records;
    DELETE FROM notification_jobs;
    DELETE FROM patients;
    DELETE FROM staff_users;
    DELETE FROM staff_invites;
    DELETE FROM facilities;
  `);
}

function seed(): void {
  initSchema();
  reset();

  const FACILITY = 'RURAL-CLINIC-01';
  const PHARMACY = 'PHARM-01';

  // Facility profile with departments (drives the admin dashboard breakdown).
  upsertFacility({
    code: FACILITY,
    name: 'Rural Clinic 01',
    address: '1 Clinic Rd, Demo Town',
    phone: '+15550000000',
    departments: ['Reception', 'General Medicine', 'Pediatrics', 'Pharmacy'],
    specialties: 'General medicine, maternal health, basic pediatrics',
  });
  upsertFacility({
    code: PHARMACY,
    name: 'Community Pharmacy 01',
    address: '2 Market St, Demo Town',
    phone: '+15550000001',
    departments: ['Pharmacy'],
    specialties: 'Dispensing, restock',
  });

  // Staff logins (synthetic). One multi-role account to demo role selection.
  const staff = [
    { email: 'admin@clinic.test', password: 'demo1234', name: 'Ada Admin', roles: ['Admin'], facility: FACILITY, department: 'Reception' },
    { email: 'reception@clinic.test', password: 'demo1234', name: 'Ravi Reception', roles: ['Receptionist'], facility: FACILITY, department: 'Reception' },
    { email: 'doctor@clinic.test', password: 'demo1234', name: 'Dr. Dana Okafor', roles: ['Doctor'], facility: FACILITY, department: 'General Medicine' },
    { email: 'pharmacy@clinic.test', password: 'demo1234', name: 'Priya Pharmacist', roles: ['Pharmacy'], facility: PHARMACY, department: 'Pharmacy' },
    { email: 'multi@clinic.test', password: 'demo1234', name: 'Sam Multi', roles: ['Doctor', 'Receptionist'], facility: FACILITY, department: 'Pediatrics' },
  ] as const;

  for (const s of staff) {
    createStaffUser({
      email: s.email,
      password: s.password,
      name: s.name,
      phone: null,
      facilityCode: s.facility,
      department: s.department,
      roles: s.roles as any,
    });
  }

  // A couple of synthetic patients so search/queue have content.
  createPatient({
    email: 'jordan.patient@example.test',
    name: 'Jordan Rivera',
    phone: '+15550100001',
    nationalId: 'SYN-0001',
    address: '12 Example Rd, Demo Town',
    bloodType: 'O+',
    allergies: 'Penicillin',
  });
  createPatient({
    email: 'mina.patient@example.test',
    name: 'Mina Haddad',
    phone: '+15550100002',
    nationalId: 'SYN-0002',
    address: '7 Sample St, Demo Town',
    bloodType: 'A-',
    allergies: null,
  });

  // eslint-disable-next-line no-console
  console.log('Seed complete. Demo logins (all password: demo1234):');
  for (const s of staff) {
    console.log(`  ${s.email.padEnd(24)} roles=${s.roles.join(',')}`);
  }
  console.log('Synthetic patients: Jordan Rivera, Mina Haddad');
}

seed();
