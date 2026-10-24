export type Role = 'Admin' | 'Receptionist' | 'Doctor' | 'Pharmacy' | 'Technician';

export type QueueStatus = 'Waiting' | 'InProgress' | 'Completed';
export type VisitStatus = 'Open' | 'Finalized';

/**
 * EHR record categories. A technician's specialty is one of these (never
 * 'General'), and they may only read records in that category.
 */
export const EHR_CATEGORIES = [
  'General',
  'Orthopedic',
  'Cardiac',
  'Psychiatric',
  'Radiology',
  'Laboratory',
] as const;
export type EhrCategory = (typeof EHR_CATEGORIES)[number];
export const TECHNICIAN_SPECIALTIES: EhrCategory[] = EHR_CATEGORIES.filter(
  (c) => c !== 'General'
);

export interface StaffUser {
  id: number;
  email: string;
  name: string;
  phone: string | null;
  facilityCode: string;
  department: string;
  roles: Role[];
  /** Technician specialty (an EHR category). Null for other roles. */
  specialty: EhrCategory | null;
  licenseNumber: string | null;
  createdAt: string;
}

export type FacilityKind = 'Hospital' | 'Pharmacy';

export interface Facility {
  code: string;
  name: string;
  kind: FacilityKind;
  address: string | null;
  phone: string | null;
  operatingHours: string | null;
  departments: string[];
  specialties: string | null;
  updatedAt: string;
}

export interface StaffInvite {
  id: number;
  email: string;
  roles: Role[];
  department: string;
  specialty: EhrCategory | null;
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
  /** Days of supply; drives the refill-due date. Optional (older plans lack it). */
  daysSupply?: number;
}

export interface Visit {
  id: number;
  patientId: number;
  doctorId: number;
  queueEntryId: number | null;
  /** Bed this visit currently occupies, if any. Freed when the visit finalizes. */
  bedId: number | null;
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
  patientId: number | null;
  pharmacyCode: string;
  itemsDispensed: string;
  dispensedAt: string;
}

export interface EhrRecord {
  id: number;
  patientId: number;
  visitId: number | null;
  facilityCode: string;
  category: EhrCategory;
  title: string;
  content: string;
  authorId: number | null;
  createdAt: string;
}

export interface AccessGrant {
  id: number;
  patientId: number;
  grantedToDoctorId: number;
  grantedBy: 'patient' | 'peerDoctor';
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export type AppointmentStatus = 'Scheduled' | 'Cancelled' | 'Completed';

export interface Appointment {
  id: number;
  patientId: number;
  doctorId: number;
  facilityCode: string;
  scheduledAt: string;
  reason: string | null;
  status: AppointmentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface StockItem {
  id: number;
  pharmacyCode: string;
  medicationName: string;
  quantity: number;
  unitPriceCents: number;
  supplier: string | null;
  updatedAt: string;
}

export interface ServicePrice {
  id: number;
  facilityCode: string;
  serviceName: string;
  condition: string | null;
  estimatedCents: number;
}

export interface InsurancePlan {
  id: number;
  name: string;
  provider: string;
  monthlyPremiumCents: number;
  coveragePercent: number;
  description: string | null;
}

export interface PatientInsurance {
  patientId: number;
  plan: InsurancePlan;
  memberId: string | null;
  startDate: string;
}

export type ChargeStatus = 'Outstanding' | 'Paid';

export interface Charge {
  id: number;
  patientId: number;
  facilityCode: string;
  source: 'Visit' | 'Pharmacy';
  sourceId: number | null;
  description: string;
  amountCents: number;
  insuranceCents: number;
  patientCents: number;
  referringFacilityCode: string | null;
  status: ChargeStatus;
  createdAt: string;
}

/** Fixed vocabulary shared by patient needs and facility support. */
export const ACCOMMODATIONS = [
  'Wheelchair access',
  'Sign language interpreter',
  'Language translator',
  'Visual impairment support',
  'Ground-floor access',
  'Special dietary needs',
  'Private room',
] as const;

export interface FacilityAccommodation {
  id: number;
  facilityCode: string;
  accommodation: string;
  capacity: number;
  inUse: number;
}

export const ROOM_STATUSES = ['Available', 'Occupied', 'Cleaning', 'Maintenance'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export interface Room {
  id: number;
  facilityCode: string;
  name: string;
  roomType: string;
  status: RoomStatus;
  updatedAt: string;
}

// Unified equipment status vocabulary: the union of both merged feature sets.
// 'OutOfService' comes from the facility-ops UI; 'Broken' from the receptionist
// seat-map. Both are retained so neither stack breaks.
export const EQUIPMENT_STATUSES = [
  'Operational',
  'InUse',
  'Maintenance',
  'OutOfService',
  'Broken',
] as const;
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

/**
 * Unified equipment record (superset of both merged schemas).
 * - `category` + `location` are used by the facility-ops / technician UI.
 * - `room` is used by the receptionist availability seat-map (equipment-by-room).
 * All three are optional at the type level so both consumer stacks work.
 */
export interface Equipment {
  id: number;
  facilityCode: string;
  name: string;
  category: string;
  location: string | null;
  room: string | null;
  status: EquipmentStatus;
  updatedAt: string;
}

export interface StaffShift {
  id: number;
  staffId: number;
  facilityCode: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
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

export type BedWard = 'Regular' | 'Emergency';
export type BedStatus = 'Available' | 'Occupied' | 'Reserved' | 'Cleaning' | 'OutOfService';

export interface Bed {
  id: number;
  facilityCode: string;
  ward: BedWard | string;
  room: string;
  label: string;
  status: BedStatus;
  updatedAt: string;
}

/**
 * Who currently occupies a bed, derived from the open visit assigned to it.
 * Used by the receptionist occupancy board to direct visitors — it carries
 * names and location only, never any clinical content.
 */
export interface BedOccupancy {
  bedId: number;
  visitId: number;
  patientName: string;
  doctorName: string;
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

// ---- Wearables -------------------------------------------------------------

export type WearableProvider = 'WHOOP';
/** 'whoop' = live WHOOP API via OAuth; 'simulated' = synthetic demo data. */
export type WearableMode = 'whoop' | 'simulated';

export interface WearableConsent {
  id: number;
  patientId: number;
  provider: WearableProvider;
  consentVersion: string;
  consentTextSha256: string;
  signatureName: string;
  shareWithDoctors: boolean;
  allowResearch: boolean;
  signedAt: string;
  withdrawnAt: string | null;
}

export interface WearableConnection {
  id: number;
  patientId: number;
  provider: WearableProvider;
  mode: WearableMode;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  connectedAt: string;
  lastSyncedAt: string | null;
}

/** The measurement fields of one day of wearable data (all optional). */
export interface WearableMetrics {
  restingHr: number | null;
  avgHr: number | null;
  maxHr: number | null;
  hrvMs: number | null;
  spo2Pct: number | null;
  skinTempC: number | null;
  respiratoryRate: number | null;
  systolicBp: number | null;
  diastolicBp: number | null;
  sleepTotalMin: number | null;
  sleepLightMin: number | null;
  sleepDeepMin: number | null;
  sleepRemMin: number | null;
  sleepAwakeMin: number | null;
  sleepPerformancePct: number | null;
  sleepEfficiencyPct: number | null;
  recoveryScore: number | null;
  strain: number | null;
}

export const WEARABLE_METRIC_KEYS: ReadonlyArray<keyof WearableMetrics> = [
  'restingHr', 'avgHr', 'maxHr', 'hrvMs', 'spo2Pct', 'skinTempC', 'respiratoryRate',
  'systolicBp', 'diastolicBp', 'sleepTotalMin', 'sleepLightMin', 'sleepDeepMin',
  'sleepRemMin', 'sleepAwakeMin', 'sleepPerformancePct', 'sleepEfficiencyPct',
  'recoveryScore', 'strain',
];

/** One de-identified day of wearable data, as stored. */
export interface WearableObservation extends WearableMetrics {
  id: number;
  pseudonym: string;
  source: string;
  observedOn: string;
  ingestedAt: string;
}
