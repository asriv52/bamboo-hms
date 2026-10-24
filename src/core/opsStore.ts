import { db, nowUtc } from './db';
import {
  Equipment,
  EquipmentStatus,
  FacilityAccommodation,
  Room,
  RoomStatus,
  StaffShift,
} from './types';

/**
 * Core data access for facility operations: rooms, equipment, staff shifts,
 * and accommodations (facility support + patient needs). Callers authorize.
 */

// ---- Rooms ------------------------------------------------------------------

function rowToRoom(row: any): Room {
  return {
    id: row.id,
    facilityCode: row.facility_code,
    name: row.name,
    roomType: row.room_type,
    status: row.status as RoomStatus,
    updatedAt: row.updated_at,
  };
}

export function createRoom(input: {
  facilityCode: string;
  name: string;
  roomType: string;
  status: RoomStatus;
}): Room {
  const info = db
    .prepare(
      'INSERT INTO rooms (facility_code, name, room_type, status, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(input.facilityCode, input.name, input.roomType, input.status, nowUtc());
  return getRoom(Number(info.lastInsertRowid))!;
}

export function getRoom(id: number): Room | null {
  const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
  return row ? rowToRoom(row) : null;
}

export function listRooms(facilityCode: string): Room[] {
  return (
    db.prepare('SELECT * FROM rooms WHERE facility_code = ? ORDER BY name').all(facilityCode) as any[]
  ).map(rowToRoom);
}

export function setRoomStatus(id: number, status: RoomStatus): void {
  db.prepare('UPDATE rooms SET status = ?, updated_at = ? WHERE id = ?').run(status, nowUtc(), id);
}

// ---- Equipment --------------------------------------------------------------

function rowToEquipment(row: any): Equipment {
  return {
    id: row.id,
    facilityCode: row.facility_code,
    name: row.name,
    category: row.category,
    location: row.location,
    status: row.status as EquipmentStatus,
    updatedAt: row.updated_at,
  };
}

export function createEquipment(input: {
  facilityCode: string;
  name: string;
  category: string;
  location: string | null;
  status: EquipmentStatus;
}): Equipment {
  const info = db
    .prepare(
      'INSERT INTO equipment (facility_code, name, category, location, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(input.facilityCode, input.name, input.category, input.location, input.status, nowUtc());
  return getEquipment(Number(info.lastInsertRowid))!;
}

export function getEquipment(id: number): Equipment | null {
  const row = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
  return row ? rowToEquipment(row) : null;
}

export function listEquipment(facilityCode: string): Equipment[] {
  return (
    db
      .prepare('SELECT * FROM equipment WHERE facility_code = ? ORDER BY category, name')
      .all(facilityCode) as any[]
  ).map(rowToEquipment);
}

export function setEquipmentStatus(id: number, status: EquipmentStatus): void {
  db.prepare('UPDATE equipment SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    nowUtc(),
    id
  );
}

// ---- Staff shifts -----------------------------------------------------------

function rowToShift(row: any): StaffShift {
  return {
    id: row.id,
    staffId: row.staff_id,
    facilityCode: row.facility_code,
    dayOfWeek: row.day_of_week,
    startTime: row.start_time,
    endTime: row.end_time,
  };
}

export function createShift(input: Omit<StaffShift, 'id'>): StaffShift {
  const info = db
    .prepare(
      'INSERT INTO staff_shifts (staff_id, facility_code, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?, ?)'
    )
    .run(input.staffId, input.facilityCode, input.dayOfWeek, input.startTime, input.endTime);
  return rowToShift(db.prepare('SELECT * FROM staff_shifts WHERE id = ?').get(Number(info.lastInsertRowid)));
}

export function getShift(id: number): StaffShift | null {
  const row = db.prepare('SELECT * FROM staff_shifts WHERE id = ?').get(id);
  return row ? rowToShift(row) : null;
}

export function deleteShift(id: number): void {
  db.prepare('DELETE FROM staff_shifts WHERE id = ?').run(id);
}

export function listShifts(facilityCode: string): StaffShift[] {
  return (
    db
      .prepare(
        'SELECT * FROM staff_shifts WHERE facility_code = ? ORDER BY day_of_week, start_time'
      )
      .all(facilityCode) as any[]
  ).map(rowToShift);
}

// ---- Accommodations ---------------------------------------------------------

function rowToAccommodation(row: any): FacilityAccommodation {
  return {
    id: row.id,
    facilityCode: row.facility_code,
    accommodation: row.accommodation,
    capacity: row.capacity,
    inUse: row.in_use,
  };
}

export function upsertFacilityAccommodation(input: {
  facilityCode: string;
  accommodation: string;
  capacity: number;
  inUse: number;
}): void {
  db.prepare(
    `INSERT INTO facility_accommodations (facility_code, accommodation, capacity, in_use)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(facility_code, accommodation) DO UPDATE SET
       capacity = excluded.capacity, in_use = excluded.in_use`
  ).run(input.facilityCode, input.accommodation, input.capacity, input.inUse);
}

export function deleteFacilityAccommodation(facilityCode: string, accommodation: string): void {
  db.prepare('DELETE FROM facility_accommodations WHERE facility_code = ? AND accommodation = ?').run(
    facilityCode,
    accommodation
  );
}

export function listFacilityAccommodations(facilityCode?: string): FacilityAccommodation[] {
  const rows = facilityCode
    ? db
        .prepare('SELECT * FROM facility_accommodations WHERE facility_code = ? ORDER BY accommodation')
        .all(facilityCode)
    : db.prepare('SELECT * FROM facility_accommodations ORDER BY facility_code, accommodation').all();
  return (rows as any[]).map(rowToAccommodation);
}

export function getPatientAccommodations(patientId: number): string[] {
  const row = db
    .prepare('SELECT needs FROM patient_accommodations WHERE patient_id = ?')
    .get(patientId) as any;
  return row ? (JSON.parse(row.needs) as string[]) : [];
}

export function setPatientAccommodations(patientId: number, needs: string[]): void {
  db.prepare(
    `INSERT INTO patient_accommodations (patient_id, needs, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(patient_id) DO UPDATE SET needs = excluded.needs, updated_at = excluded.updated_at`
  ).run(patientId, JSON.stringify(needs), nowUtc());
}
