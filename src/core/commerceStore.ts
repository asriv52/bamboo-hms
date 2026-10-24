import { db, nowUtc } from './db';
import { decryptPII, encryptPII } from './crypto';
import {
  Charge,
  ChargeStatus,
  InsurancePlan,
  PatientInsurance,
  ServicePrice,
  StockItem,
} from './types';

/**
 * Core data access for money-related entities: pharmacy stock and pricing,
 * published service estimates, the insurance marketplace, patient coverage,
 * and charges (bills). Callers must authorize first.
 */

// ---- Pharmacy stock ---------------------------------------------------------

function rowToStock(row: any): StockItem {
  return {
    id: row.id,
    pharmacyCode: row.pharmacy_code,
    medicationName: row.medication_name,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    supplier: row.supplier,
    updatedAt: row.updated_at,
  };
}

/** Insert or update a stock line, keyed by (pharmacy, medication name). */
export function upsertStock(input: {
  pharmacyCode: string;
  medicationName: string;
  quantity: number;
  unitPriceCents: number;
  supplier: string | null;
}): StockItem {
  db.prepare(
    `INSERT INTO pharmacy_stock (pharmacy_code, medication_name, quantity, unit_price_cents, supplier, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(pharmacy_code, medication_name) DO UPDATE SET
       quantity = excluded.quantity, unit_price_cents = excluded.unit_price_cents,
       supplier = excluded.supplier, updated_at = excluded.updated_at`
  ).run(
    input.pharmacyCode,
    input.medicationName,
    input.quantity,
    input.unitPriceCents,
    input.supplier,
    nowUtc()
  );
  const row = db
    .prepare('SELECT * FROM pharmacy_stock WHERE pharmacy_code = ? AND medication_name = ?')
    .get(input.pharmacyCode, input.medicationName);
  return rowToStock(row);
}

export function getStockItem(id: number): StockItem | null {
  const row = db.prepare('SELECT * FROM pharmacy_stock WHERE id = ?').get(id);
  return row ? rowToStock(row) : null;
}

export function listStock(pharmacyCode?: string): StockItem[] {
  const rows = pharmacyCode
    ? db
        .prepare('SELECT * FROM pharmacy_stock WHERE pharmacy_code = ? ORDER BY medication_name')
        .all(pharmacyCode)
    : db.prepare('SELECT * FROM pharmacy_stock ORDER BY medication_name, pharmacy_code').all();
  return (rows as any[]).map(rowToStock);
}

/** Decrement stock atomically; returns false when there is not enough. */
export function decrementStock(id: number, quantity: number): boolean {
  const info = db
    .prepare(
      'UPDATE pharmacy_stock SET quantity = quantity - ?, updated_at = ? WHERE id = ? AND quantity >= ?'
    )
    .run(quantity, nowUtc(), id, quantity);
  return info.changes === 1;
}

// ---- Service price estimates ------------------------------------------------

function rowToPrice(row: any): ServicePrice {
  return {
    id: row.id,
    facilityCode: row.facility_code,
    serviceName: row.service_name,
    condition: row.condition,
    estimatedCents: row.estimated_cents,
  };
}

export function createServicePrice(input: {
  facilityCode: string;
  serviceName: string;
  condition: string | null;
  estimatedCents: number;
}): ServicePrice {
  const info = db
    .prepare(
      'INSERT INTO service_prices (facility_code, service_name, condition, estimated_cents) VALUES (?, ?, ?, ?)'
    )
    .run(input.facilityCode, input.serviceName, input.condition, input.estimatedCents);
  return rowToPrice(
    db.prepare('SELECT * FROM service_prices WHERE id = ?').get(Number(info.lastInsertRowid))
  );
}

export function listServicePrices(facilityCode?: string): ServicePrice[] {
  const rows = facilityCode
    ? db
        .prepare('SELECT * FROM service_prices WHERE facility_code = ? ORDER BY service_name')
        .all(facilityCode)
    : db.prepare('SELECT * FROM service_prices ORDER BY facility_code, service_name').all();
  return (rows as any[]).map(rowToPrice);
}

export function findServicePrice(facilityCode: string, serviceName: string): ServicePrice | null {
  const row = db
    .prepare(
      'SELECT * FROM service_prices WHERE facility_code = ? AND service_name = ? ORDER BY id LIMIT 1'
    )
    .get(facilityCode, serviceName);
  return row ? rowToPrice(row) : null;
}

// ---- Insurance --------------------------------------------------------------

function rowToPlan(row: any): InsurancePlan {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    monthlyPremiumCents: row.monthly_premium_cents,
    coveragePercent: row.coverage_percent,
    description: row.description,
  };
}

export function createInsurancePlan(input: Omit<InsurancePlan, 'id'>): InsurancePlan {
  const info = db
    .prepare(
      `INSERT INTO insurance_plans (name, provider, monthly_premium_cents, coverage_percent, description)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      input.name,
      input.provider,
      input.monthlyPremiumCents,
      input.coveragePercent,
      input.description
    );
  return getInsurancePlan(Number(info.lastInsertRowid))!;
}

export function getInsurancePlan(id: number): InsurancePlan | null {
  const row = db.prepare('SELECT * FROM insurance_plans WHERE id = ?').get(id);
  return row ? rowToPlan(row) : null;
}

export function listInsurancePlans(): InsurancePlan[] {
  return (db.prepare('SELECT * FROM insurance_plans ORDER BY monthly_premium_cents').all() as any[]).map(
    rowToPlan
  );
}

export function setPatientInsurance(input: {
  patientId: number;
  planId: number;
  memberId: string | null;
}): void {
  db.prepare(
    `INSERT INTO patient_insurance (patient_id, plan_id, member_id, start_date)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(patient_id) DO UPDATE SET
       plan_id = excluded.plan_id, member_id = excluded.member_id, start_date = excluded.start_date`
  ).run(input.patientId, input.planId, encryptPII(input.memberId), nowUtc().slice(0, 10));
}

export function getPatientInsurance(patientId: number): PatientInsurance | null {
  const row = db.prepare('SELECT * FROM patient_insurance WHERE patient_id = ?').get(patientId) as any;
  if (!row) return null;
  const plan = getInsurancePlan(row.plan_id);
  if (!plan) return null;
  return {
    patientId,
    plan,
    memberId: decryptPII(row.member_id),
    startDate: row.start_date,
  };
}

// ---- Charges ----------------------------------------------------------------

function rowToCharge(row: any): Charge {
  return {
    id: row.id,
    patientId: row.patient_id,
    facilityCode: row.facility_code,
    source: row.source,
    sourceId: row.source_id,
    description: row.description,
    amountCents: row.amount_cents,
    insuranceCents: row.insurance_cents,
    patientCents: row.patient_cents,
    referringFacilityCode: row.referring_facility_code,
    status: row.status as ChargeStatus,
    createdAt: row.created_at,
  };
}

export function insertCharge(input: Omit<Charge, 'id' | 'createdAt' | 'status'> & { status?: ChargeStatus }): Charge {
  const info = db
    .prepare(
      `INSERT INTO charges (patient_id, facility_code, source, source_id, description, amount_cents,
         insurance_cents, patient_cents, referring_facility_code, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.patientId,
      input.facilityCode,
      input.source,
      input.sourceId,
      input.description,
      input.amountCents,
      input.insuranceCents,
      input.patientCents,
      input.referringFacilityCode,
      input.status ?? 'Outstanding',
      nowUtc()
    );
  return getCharge(Number(info.lastInsertRowid))!;
}

export function getCharge(id: number): Charge | null {
  const row = db.prepare('SELECT * FROM charges WHERE id = ?').get(id);
  return row ? rowToCharge(row) : null;
}

export function listChargesForPatient(patientId: number): Charge[] {
  return (
    db.prepare('SELECT * FROM charges WHERE patient_id = ? ORDER BY id DESC').all(patientId) as any[]
  ).map(rowToCharge);
}

export function listChargesForFacility(facilityCode: string): Charge[] {
  return (
    db.prepare('SELECT * FROM charges WHERE facility_code = ? ORDER BY id DESC').all(facilityCode) as any[]
  ).map(rowToCharge);
}

export function setChargeStatus(id: number, status: ChargeStatus): void {
  db.prepare('UPDATE charges SET status = ? WHERE id = ?').run(status, id);
}
