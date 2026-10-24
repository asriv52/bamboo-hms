import {
  getActivePrescriptionForPatient,
  getFacility,
  getStaffById,
  getVisit,
  listFacilities,
  listPatients,
} from '../../core/entityStore';
import { listEhrForPatient, listAppointmentsForPatient } from '../../core/careStore';
import { listStock } from '../../core/commerceStore';
import { recordAudit } from '../../core/audit';
import { EHR_CATEGORIES, EhrCategory, EhrRecord, Patient } from '../../core/types';

/**
 * SMS simulator — patient-facing ONLY.
 *
 * This is a standalone, optional transport module (per steering: SMS is a
 * future/optional channel limited to patients). It depends on core/domain
 * read functions but NOTHING depends on it. It never exposes clinical content
 * to anyone but the patient who owns the record, resolved by their phone
 * number (the "SIM number" sending the text).
 *
 * Replies are kept short and line-oriented to mimic real SMS. No staff,
 * admin, pharmacy, or doctor commands exist here by design.
 */

export interface SmsReply {
  /** Lines to send back; a real gateway would split/number these. */
  lines: string[];
}

const HELP_LINES = [
  'Clinic SMS. Reply with:',
  'EHR - your health records',
  'REC <no.> - open one record',
  'MEDS - your medication plan',
  'PHARMACY - nearby pharmacies',
  'HOSPITAL - nearby hospitals',
  'APPT - your appointments',
  'HELP - this menu',
];

/** Normalize a phone to compare against stored (E.164-ish) numbers. */
function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, '');
}

/** Resolve the patient who owns this SIM/phone number. Phone is encrypted at
 * rest, so we decrypt-and-match in memory (small demo dataset). */
export function findPatientByPhone(phone: string): Patient | null {
  const want = normalizePhone(phone);
  if (!want) return null;
  return (
    listPatients().find((p) => p.phone && normalizePhone(p.phone) === want) ?? null
  );
}

/** Format cents as a short currency string. */
function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ---- EHR menus ----------------------------------------------------------------
//
// SMS has no buttons, so a "selection" is the patient replying with a number.
// We remember the last numbered list sent to each phone so "2" means the
// second item of THAT list. Menus are keyed by phone, expire after 15 minutes,
// and only ever hold record ids that belong to that phone's patient.

/** At or below this many records, EHR lists them directly. Above it, EHR asks
 *  the patient to pick a record type first. */
export const EHR_DIRECT_LIST_LIMIT = 5;
/** Most records shown in one numbered list (newest first). */
const EHR_PAGE_SIZE = 8;
const MENU_TTL_MS = 15 * 60_000;

type Menu =
  | { kind: 'records'; recordIds: number[]; expiresAt: number }
  | { kind: 'types'; categories: EhrCategory[]; expiresAt: number };

const menus = new Map<string, Menu>();

/** Test helper: forget every remembered menu. */
export function clearSmsSessions(): void {
  menus.clear();
}

/** Plain-language names for record types, shown to patients. */
const TYPE_LABELS: Record<EhrCategory, string> = {
  General: 'General health',
  Orthopedic: 'Bones & joints',
  Cardiac: 'Heart',
  Psychiatric: 'Mental health',
  Radiology: 'Scans & X-rays',
  Laboratory: 'Lab tests',
};

/** Words a patient might text after EHR to filter by type. */
const TYPE_ALIASES: Record<string, EhrCategory> = {
  GENERAL: 'General', GEN: 'General',
  ORTHOPEDIC: 'Orthopedic', ORTHO: 'Orthopedic', BONE: 'Orthopedic', BONES: 'Orthopedic', JOINT: 'Orthopedic', JOINTS: 'Orthopedic',
  CARDIAC: 'Cardiac', HEART: 'Cardiac',
  PSYCHIATRIC: 'Psychiatric', PSYCH: 'Psychiatric', MENTAL: 'Psychiatric',
  RADIOLOGY: 'Radiology', XRAY: 'Radiology', SCAN: 'Radiology', SCANS: 'Radiology', IMAGING: 'Radiology',
  LABORATORY: 'Laboratory', LAB: 'Laboratory', LABS: 'Laboratory', BLOOD: 'Laboratory',
};

function getMenu(phoneKey: string): Menu | null {
  const menu = menus.get(phoneKey);
  if (!menu) return null;
  if (menu.expiresAt < Date.now()) {
    menus.delete(phoneKey);
    return null;
  }
  return menu;
}

/**
 * Handle one inbound text from `fromPhone` with body `body`.
 * Returns the SMS reply lines. Unknown senders get a privacy-safe prompt.
 */
export function handleInboundSms(fromPhone: string, body: string): SmsReply {
  const patient = findPatientByPhone(fromPhone);
  const phoneKey = normalizePhone(fromPhone);
  const tokens = (body || '').trim().toUpperCase().split(/\s+/).filter(Boolean);
  const command = tokens[0] || 'HELP';
  const arg = tokens.slice(1).join(' ');

  // Audit every inbound text (channel + command + whether the sender is known).
  recordAudit({
    actor: null,
    action: 'sms_inbound',
    entity: 'sms',
    entityId: patient ? patient.id : null,
    detail: `from=${normalizePhone(fromPhone)} cmd=${command} known=${!!patient}`,
  });

  // Unknown number: never reveal whether a number is registered beyond a
  // generic prompt. All data commands require a known patient.
  if (!patient) {
    if (command === 'HELP') return { lines: HELP_LINES };
    return {
      lines: [
        'This number is not linked to a patient record.',
        'Text HELP for options, or visit the clinic to register.',
      ],
    };
  }

  // A bare number ("2" or "#2") picks an item from the last list sent.
  if (/^#?\d+$/.test(command)) {
    return selectionReply(patient, phoneKey, Number(command.replace('#', '')));
  }

  switch (command) {
    case 'HELP':
      return { lines: [`Hi ${patient.name.split(' ')[0]}.`, ...HELP_LINES] };

    case 'EHR':
    case 'RECORDS':
      return ehrReply(patient, phoneKey, arg);

    case 'REC':
    case 'RECORD': {
      const id = Number(arg.replace(/[^\d]/g, ''));
      if (!id) return { lines: ['Text REC followed by a record number, e.g. REC 12.'] };
      return recordDetailReply(patient, phoneKey, id);
    }

    case 'MEDS':
    case 'MED':
    case 'MEDICATION':
      return medsReply(patient);

    case 'PHARMACY':
    case 'PHARMACIES':
      return pharmacyReply();

    case 'HOSPITAL':
    case 'HOSPITALS':
      return hospitalReply();

    case 'APPT':
    case 'APPOINTMENT':
    case 'APPOINTMENTS':
      return apptReply(patient);

    default:
      return {
        lines: [
          `Sorry, "${command}" is not a command.`,
          'Text HELP to see what you can ask for.',
        ],
      };
  }
}

/**
 * EHR entry point.
 * - "EHR <type>" (e.g. EHR BONES, EHR LAB) lists records of that type.
 * - "EHR" with few records lists them as a numbered menu.
 * - "EHR" with many records asks the patient to pick a record type instead.
 */
function ehrReply(patient: Patient, phoneKey: string, arg: string): SmsReply {
  const all = listEhrForPatient(patient.id);
  if (all.length === 0) {
    return { lines: ['You have no health records on file yet.'] };
  }

  if (arg) {
    const category = TYPE_ALIASES[arg.replace(/[^A-Z]/g, '')];
    if (!category) {
      return { lines: [`"${arg}" is not a record type.`, 'Text EHR to see the types you have.'] };
    }
    return recordListReply(phoneKey, all.filter((r) => r.category === category), TYPE_LABELS[category]);
  }

  if (all.length <= EHR_DIRECT_LIST_LIMIT) {
    return recordListReply(phoneKey, all, 'Your health records');
  }
  return typeMenuReply(phoneKey, all);
}

/** Numbered list of records; remembers it so a reply number opens one. */
function recordListReply(phoneKey: string, records: EhrRecord[], heading: string): SmsReply {
  if (records.length === 0) {
    return { lines: [`You have no ${heading.toLowerCase()} records.`, 'Text EHR to see all types.'] };
  }
  const shown = records.slice(0, EHR_PAGE_SIZE);
  menus.set(phoneKey, {
    kind: 'records',
    recordIds: shown.map((r) => r.id),
    expiresAt: Date.now() + MENU_TTL_MS,
  });

  const lines = [`${heading} (${records.length}):`];
  shown.forEach((r, i) => {
    lines.push(`${i + 1}) ${r.createdAt.slice(0, 10)} ${r.title} (Rec #${r.id})`);
  });
  if (records.length > shown.length) {
    lines.push(`Showing newest ${shown.length} of ${records.length}.`);
  }
  lines.push(`Reply 1-${shown.length} for details.`);
  return { lines };
}

/** Too many records to list: ask the patient to choose a record type. */
function typeMenuReply(phoneKey: string, all: EhrRecord[]): SmsReply {
  const counts = new Map<EhrCategory, number>();
  for (const r of all) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  // Keep the fixed category order so the numbering is predictable.
  const categories = EHR_CATEGORIES.filter((c) => counts.has(c));

  menus.set(phoneKey, { kind: 'types', categories, expiresAt: Date.now() + MENU_TTL_MS });

  const lines = [`You have ${all.length} records. Pick a type:`];
  categories.forEach((c, i) => {
    lines.push(`${i + 1}) ${TYPE_LABELS[c]} (${counts.get(c)})`);
  });
  lines.push(`Reply 1-${categories.length}, or text e.g. EHR BONES.`);
  return { lines };
}

/** Handle a bare-number reply against the last menu sent to this phone. */
function selectionReply(patient: Patient, phoneKey: string, n: number): SmsReply {
  const menu = getMenu(phoneKey);
  if (!menu) {
    return { lines: ['There is no list to choose from.', 'Text EHR to see your records.'] };
  }
  const size = menu.kind === 'records' ? menu.recordIds.length : menu.categories.length;
  if (n < 1 || n > size) {
    return { lines: [`Please reply a number from 1 to ${size}.`] };
  }
  if (menu.kind === 'types') {
    const category = menu.categories[n - 1];
    const records = listEhrForPatient(patient.id, category);
    return recordListReply(phoneKey, records, TYPE_LABELS[category]);
  }
  return recordDetailReply(patient, phoneKey, menu.recordIds[n - 1]);
}

/**
 * Full detail for one record. The record is looked up among THIS patient's
 * records only, so a record number belonging to someone else returns the same
 * "not found" reply as a number that does not exist.
 */
function recordDetailReply(patient: Patient, phoneKey: string, recordId: number): SmsReply {
  const rec = listEhrForPatient(patient.id).find((r) => r.id === recordId);
  if (!rec) {
    return { lines: [`Record #${recordId} was not found in your records.`, 'Text EHR to see your records.'] };
  }

  recordAudit({
    actor: null,
    action: 'sms_ehr_view',
    entity: 'ehr_record',
    entityId: rec.id,
    detail: `patient=${patient.id}`,
  });

  const facility = getFacility(rec.facilityCode);
  const author = rec.authorId ? getStaffById(rec.authorId) : null;
  const visit = rec.visitId ? getVisit(rec.visitId) : null;

  const lines = [
    `Record #${rec.id}`,
    `Date: ${rec.createdAt.slice(0, 10)}`,
    `Type: ${TYPE_LABELS[rec.category] ?? rec.category}`,
    `Title: ${rec.title}`,
  ];
  if (facility) lines.push(`Where: ${facility.name}`);
  if (author) lines.push(`By: ${author.name}`);
  if (visit) lines.push(`Visit receipt: ${visit.accessCode}`);
  lines.push(`Notes: ${rec.content || '(none)'}`);
  if (getMenu(phoneKey)?.kind === 'records') {
    lines.push('Reply another number, or EHR for the list.');
  }
  return { lines };
}

function medsReply(patient: Patient): SmsReply {
  const rx = getActivePrescriptionForPatient(patient.id);
  if (!rx || rx.medications.length === 0) {
    return { lines: ['You have no active medication plan right now.'] };
  }
  const lines = ['Your current medications:'];
  for (const m of rx.medications) {
    const supply = (m as any).daysSupply ? `, ${(m as any).daysSupply}d supply` : '';
    lines.push(`- ${m.name} ${m.dosage}: ${m.instructions}${supply}`);
  }
  // Restock reminder: flag the soonest run-out based on daysSupply, if present.
  const withSupply = rx.medications
    .map((m) => (m as any).daysSupply as number | undefined)
    .filter((d): d is number => typeof d === 'number');
  if (withSupply.length) {
    const soonest = Math.min(...withSupply);
    const runOut = new Date(Date.parse(rx.createdAt) + soonest * 86400_000)
      .toISOString()
      .slice(0, 10);
    lines.push(`Restock by ~${runOut}. Text PHARMACY for where to refill.`);
  } else {
    lines.push('Text PHARMACY for where to refill.');
  }
  return { lines };
}

function pharmacyReply(): SmsReply {
  const pharmacies = listFacilities('Pharmacy');
  if (pharmacies.length === 0) return { lines: ['No pharmacies are listed nearby.'] };
  const lines = ['Nearby pharmacies:'];
  for (const f of pharmacies) {
    lines.push(`- ${f.name}${f.address ? `, ${f.address}` : ''}`);
    const stock = listStock(f.code).filter((s) => s.quantity > 0);
    if (stock.length) {
      const sample = stock
        .slice(0, 3)
        .map((s) => `${s.medicationName} ${money(s.unitPriceCents)}`)
        .join(', ');
      lines.push(`  In stock: ${sample}${stock.length > 3 ? ', ...' : ''}`);
    }
    if (f.operatingHours) lines.push(`  Hours: ${f.operatingHours}`);
  }
  return { lines };
}

function hospitalReply(): SmsReply {
  const hospitals = listFacilities('Hospital');
  if (hospitals.length === 0) return { lines: ['No hospitals are listed nearby.'] };
  const lines = ['Nearby hospitals/clinics:'];
  for (const f of hospitals) {
    lines.push(`- ${f.name}${f.address ? `, ${f.address}` : ''}`);
    if (f.specialties) lines.push(`  Specialties: ${f.specialties}`);
    if (f.operatingHours) lines.push(`  Hours: ${f.operatingHours}`);
    if (f.phone) lines.push(`  Call: ${f.phone}`);
  }
  return { lines };
}

function apptReply(patient: Patient): SmsReply {
  const now = Date.now();
  const upcoming = listAppointmentsForPatient(patient.id)
    .filter((a) => a.status === 'Scheduled' && Date.parse(a.scheduledAt) >= now)
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  if (upcoming.length === 0) {
    return { lines: ['You have no upcoming appointments scheduled.'] };
  }
  const lines = ['Your upcoming appointments:'];
  for (const a of upcoming.slice(0, 5)) {
    const when = a.scheduledAt.replace('T', ' ').slice(0, 16) + ' UTC';
    lines.push(`- ${when}${a.reason ? ` (${a.reason})` : ''}`);
  }
  lines.push('Reminder: arrive 10 min early.');
  return { lines };
}
