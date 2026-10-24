import { recordAudit } from '../../core/audit';
import { AccessDenied, requireFeature } from '../../core/accessControl';
import { getStaffById, listStaffByFacility } from '../../core/entityStore';
import {
  createEquipment,
  createRoom,
  createShift,
  deleteFacilityAccommodation,
  deleteShift,
  getEquipment,
  getRoom,
  getShift,
  listEquipment,
  listFacilityAccommodations,
  listRooms,
  listShifts,
  setEquipmentStatus,
  setRoomStatus,
  upsertFacilityAccommodation,
} from '../../core/opsStore';
import {
  ACCOMMODATIONS,
  Actor,
  EHR_CATEGORIES,
  Equipment,
  EQUIPMENT_STATUSES,
  FacilityAccommodation,
  Room,
  ROOM_STATUSES,
} from '../../core/types';
import {
  optionalText,
  parseIntInRange,
  requireOneOf,
  requireText,
  requireTimeOfDay,
  ValidationError,
} from '../../core/validation';

/**
 * Facility operations module (hospital class): rooms, equipment, staff
 * availability, and accommodation capacity. All data is scoped to the actor's
 * own facility. None of it contains patient data.
 *
 * Equipment is the one shared view: admins see all of their
 * facility's equipment; technicians see only their specialty's equipment plus
 * general equipment.
 */

// ---- Rooms ------------------------------------------------------------------

export function listFacilityRooms(actor: Actor): Room[] {
  requireFeature(actor, 'rooms.manage');
  return listRooms(actor.facilityCode);
}

export function addRoom(actor: Actor, input: Record<string, unknown>): Room {
  requireFeature(actor, 'rooms.manage');
  const room = createRoom({
    facilityCode: actor.facilityCode,
    name: requireText(input.name, 'Room name'),
    roomType: requireText(input.roomType, 'Room type'),
    status: requireOneOf(input.status ?? 'Available', ROOM_STATUSES, 'Status'),
  });
  recordAudit({ actor, action: 'room_create', entity: 'room', entityId: room.id, detail: room.name });
  return room;
}

export function updateRoomStatus(actor: Actor, roomId: number, statusRaw: unknown): void {
  requireFeature(actor, 'rooms.manage');
  const room = getRoom(roomId);
  if (!room || room.facilityCode !== actor.facilityCode) throw new AccessDenied('That room could not be found.');
  const status = requireOneOf(statusRaw, ROOM_STATUSES, 'Status');
  setRoomStatus(roomId, status);
  recordAudit({ actor, action: 'room_status', entity: 'room', entityId: roomId, detail: status });
}

// ---- Equipment --------------------------------------------------------------

export function listEquipmentFor(actor: Actor): Equipment[] {
  requireFeature(actor, 'equipment.read');
  const all = listEquipment(actor.facilityCode);
  if (actor.activeRole !== 'Technician') return all;
  const specialty = getStaffById(actor.userId)?.specialty ?? null;
  return all.filter((e) => e.category === 'General' || (specialty && e.category === specialty));
}

export function addEquipment(actor: Actor, input: Record<string, unknown>): Equipment {
  requireFeature(actor, 'equipment.manage');
  const eq = createEquipment({
    facilityCode: actor.facilityCode,
    name: requireText(input.name, 'Equipment name'),
    category: requireOneOf(input.category ?? 'General', EHR_CATEGORIES, 'Category'),
    location: optionalText(input.location),
    status: requireOneOf(input.status ?? 'Operational', EQUIPMENT_STATUSES, 'Status'),
  });
  recordAudit({ actor, action: 'equipment_create', entity: 'equipment', entityId: eq.id, detail: eq.name });
  return eq;
}

export function updateEquipmentStatus(actor: Actor, equipmentId: number, statusRaw: unknown): void {
  requireFeature(actor, 'equipment.manage');
  const eq = getEquipment(equipmentId);
  if (!eq || eq.facilityCode !== actor.facilityCode) throw new AccessDenied('That equipment could not be found.');
  const status = requireOneOf(statusRaw, EQUIPMENT_STATUSES, 'Status');
  setEquipmentStatus(equipmentId, status);
  recordAudit({ actor, action: 'equipment_status', entity: 'equipment', entityId: equipmentId, detail: status });
}

// ---- Staff availability -----------------------------------------------------

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface StaffAvailabilityRow {
  staffId: number;
  name: string;
  roles: string[];
  department: string;
  specialty: string | null;
  onDutyNow: boolean;
  shifts: Array<{ id: number; day: string; startTime: string; endTime: string }>;
}

/** Shifts are stored in UTC; "on duty now" compares against the current UTC time. */
export function getStaffAvailability(actor: Actor, now = new Date()): StaffAvailabilityRow[] {
  requireFeature(actor, 'staff_availability');
  const shifts = listShifts(actor.facilityCode);
  const day = now.getUTCDay();
  const hhmm = now.toISOString().slice(11, 16);
  return listStaffByFacility(actor.facilityCode).map((s) => {
    const mine = shifts.filter((sh) => sh.staffId === s.id);
    return {
      staffId: s.id,
      name: s.name,
      roles: s.roles,
      department: s.department,
      specialty: s.specialty,
      onDutyNow: mine.some((sh) => sh.dayOfWeek === day && sh.startTime <= hhmm && hhmm < sh.endTime),
      shifts: mine.map((sh) => ({
        id: sh.id,
        day: DAY_NAMES[sh.dayOfWeek],
        startTime: sh.startTime,
        endTime: sh.endTime,
      })),
    };
  });
}

export function addShift(actor: Actor, input: Record<string, unknown>): void {
  requireFeature(actor, 'staff_availability');
  const staff = getStaffById(Number(input.staffId));
  if (!staff || staff.facilityCode !== actor.facilityCode) {
    throw new ValidationError('That staff member could not be found at your facility.');
  }
  const dayOfWeek = parseIntInRange(input.dayOfWeek, 'Day', 0, 6);
  const startTime = requireTimeOfDay(input.startTime, 'Start time');
  const endTime = requireTimeOfDay(input.endTime, 'End time');
  if (endTime <= startTime) throw new ValidationError('End time must be after start time.');
  const shift = createShift({ staffId: staff.id, facilityCode: actor.facilityCode, dayOfWeek, startTime, endTime });
  recordAudit({ actor, action: 'shift_create', entity: 'staff_shift', entityId: shift.id, detail: `${staff.id} ${DAY_NAMES[dayOfWeek]} ${startTime}-${endTime}` });
}

export function removeShift(actor: Actor, shiftId: number): void {
  requireFeature(actor, 'staff_availability');
  const shift = getShift(shiftId);
  if (!shift || shift.facilityCode !== actor.facilityCode) throw new AccessDenied('That shift could not be found.');
  deleteShift(shiftId);
  recordAudit({ actor, action: 'shift_delete', entity: 'staff_shift', entityId: shiftId });
}

// ---- Accommodations ---------------------------------------------------------

export function listAccommodationAvailability(actor: Actor): FacilityAccommodation[] {
  requireFeature(actor, 'accommodations.manage');
  return listFacilityAccommodations(actor.facilityCode);
}

export function setAccommodation(actor: Actor, input: Record<string, unknown>): void {
  requireFeature(actor, 'accommodations.manage');
  const accommodation = requireOneOf(input.accommodation, ACCOMMODATIONS, 'Accommodation');
  const capacity = parseIntInRange(input.capacity, 'Capacity', 0, 10000);
  const inUse = parseIntInRange(input.inUse ?? '0', 'In use', 0, 10000);
  if (inUse > capacity) throw new ValidationError('In use cannot exceed capacity.');
  if (capacity === 0) {
    deleteFacilityAccommodation(actor.facilityCode, accommodation);
  } else {
    upsertFacilityAccommodation({ facilityCode: actor.facilityCode, accommodation, capacity, inUse });
  }
  recordAudit({ actor, action: 'accommodation_set', entity: 'facility', entityId: null, detail: `${accommodation} ${inUse}/${capacity}` });
}
