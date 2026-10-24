import { requireRole } from '../../core/accessControl';
import { recordAudit } from '../../core/audit';
import {
  clearBedOccupancy,
  createVisit,
  getBed,
  getOpenVisitByBed,
  getPatientById,
  getStaffById,
  listBedOccupancyByFacility,
  listBedsByFacility,
  listPatients,
  listStaffByFacility,
  updateBedStatus,
} from '../../core/entityStore';
import { getEquipment, listEquipment, setEquipmentStatus as storeSetEquipmentStatus } from '../../core/opsStore';
import {
  Actor,
  Bed,
  BedOccupancy,
  BedStatus,
  EQUIPMENT_STATUSES,
  Equipment,
  EquipmentStatus,
  Patient,
  StaffUser,
} from '../../core/types';
import { ValidationError } from '../../core/validation';

/**
 * Bed / room / equipment availability + occupancy module.
 *
 * RECEPTIONIST-only and strictly scoped to the receptionist's own facility:
 * every read and write is filtered by actor.facilityCode so one hospital can
 * never see or change another hospital's beds or equipment. Status changes are
 * audited.
 *
 * The view model is shaped for the "seat-map" UI: beds grouped by ward then
 * room so the template can render each room as a block of seats. Each bed may
 * carry an occupancy entry (which patient + which doctor) so the receptionist
 * can direct arriving visitors to the right place. Occupancy is location /
 * assignment data only — never diagnoses, notes, medications, or results.
 */

const BED_STATUSES: BedStatus[] = [
  'Available',
  'Occupied',
  'Reserved',
  'Cleaning',
  'OutOfService',
];


/** A bed plus who is in it (if anyone), for the occupancy board. */
export interface BedView {
  bed: Bed;
  occupancy: BedOccupancy | null;
}

export interface RoomGroup {
  room: string;
  beds: BedView[];
  /** Occupants in this room, for directing visitors to equipment in the room. */
  occupants: BedOccupancy[];
}

export interface WardGroup {
  ward: string;
  rooms: RoomGroup[];
  counts: { total: number; available: number };
}

/** Equipment plus the patients whose open visit is assigned to a bed in the same room. */
export interface EquipmentView {
  equipment: Equipment;
  roomOccupants: BedOccupancy[];
}

/** Per-room occupancy count for the distribution dashboard. */
export interface RoomDistribution {
  ward: string;
  room: string;
  occupied: number;
  total: number;
}

/** Building-wide distribution so the receptionist sees load at a glance. */
export interface Distribution {
  totalPatientsInBuilding: number;
  byWard: Array<{ ward: string; occupied: number; total: number }>;
  byRoom: RoomDistribution[];
}

/** A selectable patient or doctor for the assign-occupant form. */
export interface AssignOption {
  id: number;
  name: string;
}

export interface AvailabilityView {
  facilityCode: string;
  wards: WardGroup[];
  equipment: EquipmentView[];
  bedStatuses: BedStatus[];
  equipmentStatuses: EquipmentStatus[];
  totals: { beds: number; availableBeds: number; equipment: number; operationalEquipment: number };
  distribution: Distribution;
  /** Patients available to assign to a bed. */
  patientOptions: AssignOption[];
  /** Doctors at this facility available to assign to a bed. */
  doctorOptions: AssignOption[];
}

/**
 * Build the full availability + occupancy view for the receptionist's facility.
 */
export function getAvailability(actor: Actor): AvailabilityView {
  requireRole(actor, 'Receptionist');

  const beds = listBedsByFacility(actor.facilityCode);
  const equipment = listEquipment(actor.facilityCode);
  const occupancy = listBedOccupancyByFacility(actor.facilityCode);
  const occByBed = new Map<number, BedOccupancy>(occupancy.map((o) => [o.bedId, o]));

  // room -> occupants, so equipment in a room can show who is being treated there.
  const roomToBed = new Map<number, string>(beds.map((b) => [b.id, b.room]));
  const roomOccupants = new Map<string, BedOccupancy[]>();
  for (const o of occupancy) {
    const room = roomToBed.get(o.bedId);
    if (!room) continue;
    if (!roomOccupants.has(room)) roomOccupants.set(room, []);
    roomOccupants.get(room)!.push(o);
  }

  // Group beds -> ward -> room, preserving the store's stable ordering.
  const wardMap = new Map<string, Map<string, Bed[]>>();
  for (const bed of beds) {
    if (!wardMap.has(bed.ward)) wardMap.set(bed.ward, new Map());
    const roomMap = wardMap.get(bed.ward)!;
    if (!roomMap.has(bed.room)) roomMap.set(bed.room, []);
    roomMap.get(bed.room)!.push(bed);
  }

  const wards: WardGroup[] = [...wardMap.entries()].map(([ward, roomMap]) => {
    const rooms: RoomGroup[] = [...roomMap.entries()].map(([room, roomBeds]) => ({
      room,
      beds: roomBeds.map((bed) => ({
        bed,
        occupancy: occByBed.get(bed.id) ?? null,
      })),
      occupants: roomOccupants.get(room) ?? [],
    }));
    const wardBeds = rooms.flatMap((r) => r.beds.map((bv) => bv.bed));
    return {
      ward,
      rooms,
      counts: {
        total: wardBeds.length,
        available: wardBeds.filter((b) => b.status === 'Available').length,
      },
    };
  });

  const equipmentView: EquipmentView[] = equipment.map((e) => ({
    equipment: e,
    roomOccupants: (e.room ? roomOccupants.get(e.room) : undefined) ?? [],
  }));

  const totals = {
    beds: beds.length,
    availableBeds: beds.filter((b) => b.status === 'Available').length,
    equipment: equipment.length,
    operationalEquipment: equipment.filter((e) => e.status === 'Operational').length,
  };

  // Distribution: how many patients are in each ward/room right now. "Occupied"
  // here means a bed that currently holds an assigned open visit.
  const occupiedBedIds = new Set(occupancy.map((o) => o.bedId));
  const byRoom: RoomDistribution[] = wards.flatMap((w) =>
    w.rooms.map((r) => ({
      ward: w.ward,
      room: r.room,
      occupied: r.beds.filter((bv) => occupiedBedIds.has(bv.bed.id)).length,
      total: r.beds.length,
    }))
  );
  const byWard = wards.map((w) => ({
    ward: w.ward,
    occupied: w.rooms
      .flatMap((r) => r.beds)
      .filter((bv) => occupiedBedIds.has(bv.bed.id)).length,
    total: w.counts.total,
  }));
  const distribution: Distribution = {
    totalPatientsInBuilding: occupancy.length,
    byWard,
    byRoom,
  };

  // Assign options: all patients, and all doctors at this facility.
  const patientOptions: AssignOption[] = listPatients().map((p) => ({ id: p.id, name: p.name }));
  const doctorOptions: AssignOption[] = listStaffByFacility(actor.facilityCode)
    .filter((s) => s.roles.includes('Doctor'))
    .map((s) => ({ id: s.id, name: s.name }));

  return {
    facilityCode: actor.facilityCode,
    wards,
    equipment: equipmentView,
    bedStatuses: BED_STATUSES,
    equipmentStatuses: [...EQUIPMENT_STATUSES],
    totals,
    distribution,
    patientOptions,
    doctorOptions,
  };
}

/**
 * Change a bed's status. Facility-scoped + audited.
 *
 * Making a bed Available frees it: any open visit assigned to it is detached so
 * the patient + doctor vanish from that room. The patient record is NOT
 * deleted — only the bed assignment clears.
 */
export function setBedStatus(actor: Actor, bedId: number, status: string): Bed {
  requireRole(actor, 'Receptionist');
  if (!BED_STATUSES.includes(status as BedStatus)) {
    throw new ValidationError('Unknown bed status.');
  }
  const updated = updateBedStatus(actor.facilityCode, bedId, status as BedStatus);
  if (!updated) {
    // Either the bed does not exist or belongs to another facility. Same error
    // for both so we never reveal another facility's bed ids.
    throw new ValidationError('That bed could not be updated.');
  }
  // Freeing a bed releases its occupant (patient stays in the database).
  if (status === 'Available') {
    const cleared = clearBedOccupancy(actor.facilityCode, bedId);
    if (cleared > 0) {
      recordAudit({
        actor,
        action: 'bed_occupancy_release',
        entity: 'bed',
        entityId: bedId,
        detail: 'Occupant released (bed set Available)',
      });
    }
  }
  recordAudit({
    actor,
    action: 'bed_status_update',
    entity: 'bed',
    entityId: bedId,
    detail: `Status set to ${status}`,
  });
  return updated;
}

/**
 * Assign a patient + doctor to a bed. Creates a new open visit linked to the
 * bed and marks the bed Occupied. The receptionist records *location /
 * assignment only* — this visit carries no clinical content.
 *
 * Refuses if the bed is already occupied (free it first).
 */
export function assignOccupant(
  actor: Actor,
  bedId: number,
  patientId: number,
  doctorId: number
): Bed {
  requireRole(actor, 'Receptionist');

  const bed = getBed(bedId);
  if (!bed || bed.facilityCode !== actor.facilityCode) {
    throw new ValidationError('That bed could not be found.');
  }
  if (getOpenVisitByBed(actor.facilityCode, bedId)) {
    throw new ValidationError('That bed is already occupied. Free it first.');
  }

  const patient = getPatientById(patientId);
  if (!patient) throw new ValidationError('Please choose a valid patient.');

  const doctor = getStaffById(doctorId);
  if (!doctor || doctor.facilityCode !== actor.facilityCode || !doctor.roles.includes('Doctor')) {
    throw new ValidationError('Please choose a valid doctor at this facility.');
  }

  createVisit({
    patientId,
    doctorId,
    queueEntryId: null,
    facilityCode: actor.facilityCode,
    bedId,
  });
  const updated = updateBedStatus(actor.facilityCode, bedId, 'Occupied')!;

  recordAudit({
    actor,
    action: 'bed_occupancy_assign',
    entity: 'bed',
    entityId: bedId,
    detail: `Assigned patient ${patientId} with doctor ${doctorId}`,
  });
  return updated;
}

/**
 * Remove whoever is in a bed and mark it Available. Patient stays in the
 * database; only the bed link is cleared.
 */
export function releaseBed(actor: Actor, bedId: number): Bed {
  requireRole(actor, 'Receptionist');
  const bed = getBed(bedId);
  if (!bed || bed.facilityCode !== actor.facilityCode) {
    throw new ValidationError('That bed could not be found.');
  }
  clearBedOccupancy(actor.facilityCode, bedId);
  const updated = updateBedStatus(actor.facilityCode, bedId, 'Available')!;
  recordAudit({
    actor,
    action: 'bed_occupancy_release',
    entity: 'bed',
    entityId: bedId,
    detail: 'Occupant removed (bed freed)',
  });
  return updated;
}

/** Change an equipment item's status. Facility-scoped + audited. */
export function setEquipmentStatus(
  actor: Actor,
  equipmentId: number,
  status: string
): Equipment {
  requireRole(actor, 'Receptionist');
  if (!EQUIPMENT_STATUSES.includes(status as EquipmentStatus)) {
    throw new ValidationError('Unknown equipment status.');
  }
  // Same error for missing and other-facility equipment so ids never leak.
  const existing = getEquipment(equipmentId);
  if (!existing || existing.facilityCode !== actor.facilityCode) {
    throw new ValidationError('That equipment could not be updated.');
  }
  storeSetEquipmentStatus(equipmentId, status as EquipmentStatus);
  const updated = getEquipment(equipmentId)!;
  recordAudit({
    actor,
    action: 'equipment_status_update',
    entity: 'equipment',
    entityId: equipmentId,
    detail: `Status set to ${status}`,
  });
  return updated;
}
