export type Role = 'Admin' | 'Receptionist' | 'Doctor' | 'Pharmacy' | 'Technician';

export type QueueStatus = 'Waiting' | 'InProgress' | 'Completed';
export type VisitStatus = 'Open' | 'Finalized';

export interface StaffUser {
  id: number;
  email: string;
  name: string;
  phone: string | null;
  facilityCode: string;
  department: string;
  roles: Role[];
  createdAt: string;
}

export interface Facility {
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  departments: string[];
  specialties: string | null;
  updatedAt: string;
}

export interface StaffInvite {
  id: number;
  email: string;
  roles: Role[];
  department: string;
  facilityCode: string;
  token: string;
  status: 'pending' | 'used' | 'expired';
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export interface Patient {
  id: number;
  email: string;
  name: string;
  phone: string | null;
  nationalId: string | null;
  address: string | null;
  bloodType: string | null;
  allergies: string | null;
  createdAt: string;
}

export interface QueueEntry {
  id: number;
  patientId: number;
  facilityCode: string;
  department: string;
  status: QueueStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Medication {
  name: string;
  dosage: string;
  instructions: string;
}

export interface Visit {
  id: number;
  patientId: number;
  doctorId: number;
  queueEntryId: number | null;
  facilityCode: string;
  /** Short, human-friendly per-visit "receipt" code (e.g. RCPT-7F3K9). Unique. */
  accessCode: string;
  diagnosis: string | null;
  notes: string | null;
  status: VisitStatus;
  createdAt: string;
}

export type LabTestStatus = 'Pending' | 'Done';
export type LabTestPriority = 'Low' | 'Medium' | 'High';

export interface LabTest {
  id: number;
  visitId: number;
  testName: string;
  priority: LabTestPriority;
  status: LabTestStatus;
  notes: string | null;
  result: string | null;
  resultAttachmentId: number | null;
  createdAt: string;
}

export interface Attachment {
  id: number;
  ownerType: 'visit';
  visitId: number;
  originalName: string;
  storedName: string;
  mime: string;
  size: number;
  uploadedByRole: string;
  createdAt: string;
}

/** Email-delivered one-time password for patient-portal / record access. */
export interface Otp {
  id: number;
  context: string;
  targetEmail: string;
  codeHash: string;
  expiresAt: string;
  consumedAt: string | null;
  attempts: number;
  createdAt: string;
}

export interface Prescription {
  id: number;
  visitId: number;
  patientId: number;
  medications: Medication[];
  isActivePlan: boolean;
  pharmacyLookupToken: string;
  createdAt: string;
}

export interface DispensingRecord {
  id: number;
  prescriptionId: number;
  pharmacyCode: string;
  itemsDispensed: string;
  dispensedAt: string;
}

export interface AuditRecord {
  id: number;
  actorId: number | null;
  actorRole: string | null;
  action: string;
  entity: string;
  entityId: number | null;
  detail: string | null;
  at: string;
}

export interface NotificationJob {
  id: number;
  template: string;
  toEmail: string;
  payload: string;
  status: 'queued' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

/** The authenticated actor making a request, with the role active this session. */
export interface Actor {
  userId: number;
  activeRole: Role;
  facilityCode: string;
  department: string;
  email: string;
  name: string;
}
