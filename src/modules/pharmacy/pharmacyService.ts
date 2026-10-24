import { recordAudit } from '../../core/audit';
import { requireRole, requireFeature, AccessDenied } from '../../core/accessControl';
import { billPatient } from '../../core/billingCore';
import { decrementStock, getStockItem, listStock, upsertStock } from '../../core/commerceStore';
import {
  createDispensingRecord,
  getActivePrescriptionForPatient,
  getPatientById,
  getPrescription,
  getPrescriptionByToken,
  getVisit,
  listDispensingByPharmacy,
  listPrescriptionsForPatient,
} from '../../core/entityStore';
import { Actor, Medication, Prescription, StockItem } from '../../core/types';
import {
  optionalText,
  parseIntInRange,
  parseMoneyToCents,
  requireText,
  ValidationError,
} from '../../core/validation';

/**
 * Pharmacy domain module. A pharmacy can see ONLY a patient's active medication
 * plan (and their prior medication list), and only via a valid prescription
 * (looked up by token or by an active plan for a patient). It can never read
 * diagnoses, notes, or other health data. It also manages its own stock and
 * pricing, and sees purchase history only for patients it has dispensed to.
 */

export interface PharmacyView {
  patientName: string; // name is shown so the pharmacy can confirm identity
  medications: Medication[];
  prescriptionId: number;
  /** Medication history: prior prescriptions' medications + dates only. */
  history: Array<{ prescriptionId: number; date: string; active: boolean; medications: Medication[] }>;
  /** This pharmacy's stock lines that match the plan's medication names. */
  matchingStock: StockItem[];
}

export function lookupByToken(actor: Actor, token: string): PharmacyView {
  requireRole(actor, 'Pharmacy');
  const rx = getPrescriptionByToken(requireText(token, 'Lookup token'));
  if (!rx || !rx.isActivePlan) {
    throw new AccessDenied('No active prescription was found for that link.');
  }
  return toView(actor, rx);
}

export function lookupActivePlan(actor: Actor, patientId: number): PharmacyView {
  requireRole(actor, 'Pharmacy');
  const rx = getActivePrescriptionForPatient(patientId);
  if (!rx) {
    throw new AccessDenied('No active prescription was found for that patient.');
  }
  return toView(actor, rx);
}

function toView(actor: Actor, rx: Prescription): PharmacyView {
  const patient = getPatientById(rx.patientId);
  const names = rx.medications.map((m) => m.name.toLowerCase());
  recordAudit({ actor, action: 'pharmacy_read', entity: 'prescription', entityId: rx.id, detail: 'Active plan + medication history' });
  // Deliberately expose only name + medications — nothing clinical.
  return {
    patientName: patient?.name ?? 'Unknown',
    medications: rx.medications,
    prescriptionId: rx.id,
    history: listPrescriptionsForPatient(rx.patientId).map((p) => ({
      prescriptionId: p.id,
      date: p.createdAt.slice(0, 10),
      active: p.isActivePlan,
      medications: p.medications,
    })),
    matchingStock: listStock(actor.facilityCode).filter((s) =>
      names.some((n) => s.medicationName.toLowerCase().includes(n) || n.includes(s.medicationName.toLowerCase()))
    ),
  };
}

/**
 * Record a dispensing event. Optionally dispense a quantity of one stock line:
 * stock is decremented and the patient is billed (insurance split applied).
 */
export function recordDispensing(
  actor: Actor,
  prescriptionId: number,
  itemsDispensed: string,
  stock?: { stockItemId?: unknown; quantity?: unknown }
): void {
  requireRole(actor, 'Pharmacy');
  const rx = getPrescription(prescriptionId);
  if (!rx || !rx.isActivePlan) {
    throw new AccessDenied('No active prescription was found.');
  }

  let description = optionalText(itemsDispensed);
  let stockLine: StockItem | null = null;
  let quantity = 0;
  if (stock && stock.stockItemId) {
    stockLine = getStockItem(Number(stock.stockItemId));
    if (!stockLine || stockLine.pharmacyCode !== actor.facilityCode) {
      throw new ValidationError('Choose a stock item from your pharmacy.');
    }
    quantity = parseIntInRange(stock.quantity, 'Quantity', 1, 10000);
    if (!decrementStock(stockLine.id, quantity)) {
      throw new ValidationError(`Not enough ${stockLine.medicationName} in stock.`);
    }
    description = description ?? `${stockLine.medicationName} x${quantity}`;
  }
  description = requireText(description ?? '', 'Items dispensed');

  const dispensingId = createDispensingRecord({
    prescriptionId,
    patientId: rx.patientId,
    pharmacyCode: actor.facilityCode,
    itemsDispensed: description,
  });
  recordAudit({
    actor,
    action: 'dispense',
    entity: 'prescription',
    entityId: prescriptionId,
    detail: 'Dispensing recorded',
  });

  if (stockLine) {
    billPatient(actor, {
      patientId: rx.patientId,
      facilityCode: actor.facilityCode,
      source: 'Pharmacy',
      sourceId: dispensingId,
      description,
      amountCents: stockLine.unitPriceCents * quantity,
      referringFacilityCode: getVisit(rx.visitId)?.facilityCode ?? null,
    });
  }
}

// ---- Stock & pricing --------------------------------------------------------

export function listOwnStock(actor: Actor): StockItem[] {
  requireFeature(actor, 'pharmacy.stock.manage');
  return listStock(actor.facilityCode);
}

export function saveStockItem(actor: Actor, input: Record<string, unknown>): StockItem {
  requireFeature(actor, 'pharmacy.stock.manage');
  const item = upsertStock({
    pharmacyCode: actor.facilityCode,
    medicationName: requireText(input.medicationName, 'Medication name'),
    quantity: parseIntInRange(input.quantity, 'Quantity', 0, 1_000_000),
    unitPriceCents: parseMoneyToCents(input.unitPrice, 'Unit price'),
    supplier: optionalText(input.supplier),
  });
  recordAudit({ actor, action: 'stock_save', entity: 'pharmacy_stock', entityId: item.id, detail: `${item.medicationName} qty=${item.quantity}` });
  return item;
}

// ---- Purchase history -------------------------------------------------------

export interface PurchaseRow {
  id: number;
  patientName: string;
  itemsDispensed: string;
  dispensedAt: string;
}

/** Dispensing history at THIS pharmacy only — i.e. patients it dispensed to. */
export function getPurchaseHistory(actor: Actor): PurchaseRow[] {
  requireFeature(actor, 'pharmacy.purchase_history');
  return listDispensingByPharmacy(actor.facilityCode).map((d) => ({
    id: d.id,
    patientName: d.patientId ? getPatientById(d.patientId)?.name ?? 'Patient' : 'Patient',
    itemsDispensed: d.itemsDispensed,
    dispensedAt: d.dispensedAt,
  }));
}
