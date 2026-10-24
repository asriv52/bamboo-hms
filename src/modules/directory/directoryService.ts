import { AccessDenied, requireFeature } from '../../core/accessControl';
import { listInsurancePlans, listServicePrices, listStock } from '../../core/commerceStore';
import { getFacility, listFacilities, listStaffWithRole } from '../../core/entityStore';
import { listFacilityAccommodations } from '../../core/opsStore';
import { Actor, InsurancePlan, ServicePrice, StockItem } from '../../core/types';

/**
 * Shared-baseline public information, available to every user class:
 *   - hospital / pharmacy directory (location, operating hours, public profile)
 *   - insurance marketplace
 * Plus the public pharmacy price/stock list, visible to patients, doctors and
 * pharmacies (per the Pharmacies access rule).
 *
 * A Viewer is either an authenticated staff actor or a portal patient session.
 * Nothing here is patient-specific, so a patient viewer never sees another
 * patient's data through this module.
 */
export type Viewer = { kind: 'staff'; actor: Actor } | { kind: 'patient'; patientId: number };

function assertViewer(viewer: Viewer, feature: 'shared.directory' | 'shared.insurance_marketplace'): void {
  if (viewer.kind === 'staff') requireFeature(viewer.actor, feature);
  else if (!viewer.patientId) throw new AccessDenied();
}

export interface DirectoryEntry {
  code: string;
  name: string;
  kind: 'Hospital' | 'Pharmacy';
  address: string | null;
  phone: string | null;
  operatingHours: string | null;
  specialties: string | null;
  doctors: string[];
  accommodations: Array<{ name: string; available: number }>;
  estimatedCosts: ServicePrice[];
}

export function getDirectory(viewer: Viewer): DirectoryEntry[] {
  assertViewer(viewer, 'shared.directory');
  const doctors = listStaffWithRole('Doctor');
  return listFacilities().map((f) => ({
    code: f.code,
    name: f.name,
    kind: f.kind,
    address: f.address,
    phone: f.phone,
    operatingHours: f.operatingHours,
    specialties: f.specialties,
    // Public profile: doctor names only — no contact details.
    doctors: doctors.filter((d) => d.facilityCode === f.code).map((d) => d.name),
    accommodations: listFacilityAccommodations(f.code).map((a) => ({
      name: a.accommodation,
      available: Math.max(0, a.capacity - a.inUse),
    })),
    estimatedCosts: listServicePrices(f.code),
  }));
}

export function getInsuranceMarketplace(viewer: Viewer): InsurancePlan[] {
  assertViewer(viewer, 'shared.insurance_marketplace');
  return listInsurancePlans();
}

export interface PublicStockRow extends StockItem {
  pharmacyName: string;
  inStock: boolean;
}

/** Public pharmacy prices + stock levels: patients, doctors, and pharmacies. */
export function getPublicPharmacyStock(viewer: Viewer, medicationQuery?: string): PublicStockRow[] {
  if (viewer.kind === 'staff') requireFeature(viewer.actor, 'pharmacy.stock.read');
  const q = (medicationQuery || '').trim().toLowerCase();
  return listStock()
    .filter((s) => !q || s.medicationName.toLowerCase().includes(q))
    .map((s) => ({
      ...s,
      pharmacyName: getFacility(s.pharmacyCode)?.name ?? s.pharmacyCode,
      inStock: s.quantity > 0,
    }));
}
