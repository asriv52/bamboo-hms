import { recordAudit } from '../../core/audit';
import { AccessDenied, assertDoctorCanReadHistory, requireFeature } from '../../core/accessControl';
import { randomToken, sha256Hex } from '../../core/crypto';
import { getPatientById } from '../../core/entityStore';
import {
  createWearableConsent,
  deleteVaultEntry,
  deleteWearableConnection,
  deleteWearableObservations,
  findPseudonymForPatient,
  getActiveWearableConsent,
  getOrCreatePseudonym,
  getWearableConnection,
  listResearchConsentPatientIds,
  listWearableObservations,
  listWearableObservationsFor,
  markWearableSynced,
  resolvePseudonym,
  saveWearableConnection,
  updateWearableTokens,
  upsertWearableObservations,
  withdrawWearableConsents,
} from '../../core/wearableStore';
import {
  Actor,
  WEARABLE_METRIC_KEYS,
  WearableConsent,
  WearableMetrics,
  WearableMode,
  WearableObservation,
} from '../../core/types';
import { requireText, ValidationError } from '../../core/validation';
import {
  buildWhoopAuthorizeUrl,
  DailyWearableRecord,
  exchangeWhoopCode,
  fetchWhoopDailyRecords,
  isWhoopConfigured,
  refreshWhoopTokens,
  simulateWhoopDailyRecords,
  WhoopApiError,
} from './whoopClient';

export { WhoopApiError } from './whoopClient';

/**
 * Wearable (WHOOP) module.
 *
 * Flow:
 *   1. The patient signs a written consent in the portal (typed legal name,
 *      versioned text pinned by SHA-256, separate opt-in for research use).
 *   2. The patient connects WHOOP (OAuth) — or a simulated device in demo mode.
 *   3. Sync pulls daily metrics, strips every identifier, and stores them under
 *      a RANDOM pseudonym. The pseudonym -> patient mapping lives only in the
 *      sealed re-identification vault.
 *   4. Doctors with a care relationship see the data on the patient page.
 *   5. Research opt-ins form a de-identified ML dataset (pseudonym + day index,
 *      no dates, ids, or names).
 *   6. Re-identifying a pseudonym ("inverse" lookup) is allowed only for a
 *      doctor who already treats that patient, requires a stated reason, and
 *      is audited. Everyone else gets the same generic denial.
 *   7. Withdrawing consent deletes the data, the connection, and the vault
 *      entry, so nothing left anywhere can be linked back to the patient.
 */

export const WEARABLE_PROVIDER = 'WHOOP' as const;
export const CONSENT_VERSION = 'WHOOP-WEARABLE-v1 (2026-10)';

export const CONSENT_TEXT: readonly string[] = [
  'I authorize this clinic network to connect to my WHOOP account and collect my wearable health data: heart rate (resting, average, maximum), heart rate variability, blood oxygen (SpO2), skin temperature, respiratory rate, sleep stages and sleep scores, recovery, strain, and blood pressure when available.',
  'Before storage, my data is de-identified: my name, email, WHOOP account id, and record ids are removed, and the data is filed under a random code that is not derived from my identity.',
  'Only doctors who are treating me (a visit with me, or access I or my treating doctor granted) can see this data with my identity attached. Receptionists, administrators, pharmacies, and technicians cannot see it.',
  'If I opt in to research, my de-identified data (random code and day number only, no calendar dates) may be used to train and evaluate machine-learning models. A research result can be linked back to me only by a doctor who is already treating me, for a stated clinical reason, and every such lookup is recorded.',
  'This consent is voluntary and does not affect my care. I can withdraw at any time from the patient portal. Withdrawing stops collection, disconnects WHOOP, deletes my stored wearable data, and destroys the key that links my code to me.',
];

export const CONSENT_TEXT_SHA256 = sha256Hex(`${CONSENT_VERSION}\n${CONSENT_TEXT.join('\n')}`);

const SIMULATED_SOURCE = 'WHOOP (simulated)';
const LIVE_SOURCE = 'WHOOP';
const LIVE_LOOKBACK_DAYS = 30;
const PSEUDONYM_RE = /^WR-[0-9A-F]{24}$/;

function normalizeName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isChecked(v: unknown): boolean {
  return v === 'on' || v === 'yes' || v === 'true' || v === true || v === '1';
}

function requireActiveConsent(patientId: number): WearableConsent {
  const consent = getActiveWearableConsent(patientId, WEARABLE_PROVIDER);
  if (!consent) throw new ValidationError('Please sign the wearable data consent first.');
  return consent;
}

// ---- Patient side ------------------------------------------------------------

export interface PatientWearableOverview {
  consent: WearableConsent | null;
  connection: { mode: WearableMode; connectedAt: string; lastSyncedAt: string | null } | null;
  liveWhoopAvailable: boolean;
  recent: WearableObservation[];
  consentText: readonly string[];
  consentVersion: string;
}

/** Everything the patient's own wearable page needs (own data only). */
export function getPatientWearableOverview(patientId: number): PatientWearableOverview {
  const consent = getActiveWearableConsent(patientId, WEARABLE_PROVIDER);
  const conn = getWearableConnection(patientId);
  const pseudonym = findPseudonymForPatient(patientId);
  return {
    consent,
    connection: conn ? { mode: conn.mode, connectedAt: conn.connectedAt, lastSyncedAt: conn.lastSyncedAt } : null,
    liveWhoopAvailable: isWhoopConfigured(),
    recent: consent && pseudonym ? listWearableObservations(pseudonym, 7) : [],
    consentText: CONSENT_TEXT,
    consentVersion: CONSENT_VERSION,
  };
}

/**
 * Record the patient's written consent. The typed signature must match the
 * name on their record. Signing again replaces the previous consent (e.g. to
 * change the research opt-in) without deleting data.
 */
export function signWearableConsent(
  patientId: number,
  input: { signatureName?: unknown; agree?: unknown; allowResearch?: unknown }
): WearableConsent {
  const patient = getPatientById(patientId);
  if (!patient) throw new AccessDenied();
  if (!isChecked(input.agree)) {
    throw new ValidationError('Please tick the box to confirm you have read and agree to the consent.');
  }
  const signature = requireText(input.signatureName, 'Your full name (signature)');
  if (normalizeName(signature) !== normalizeName(patient.name)) {
    throw new ValidationError('Please type your full name exactly as it appears on your patient record.');
  }
  const allowResearch = isChecked(input.allowResearch);

  withdrawWearableConsents(patientId, WEARABLE_PROVIDER); // supersede any earlier version
  const consent = createWearableConsent({
    patientId,
    provider: WEARABLE_PROVIDER,
    consentVersion: CONSENT_VERSION,
    consentTextSha256: CONSENT_TEXT_SHA256,
    signatureName: signature,
    shareWithDoctors: true,
    allowResearch,
  });
  getOrCreatePseudonym(patientId);
  recordAudit({
    actor: null,
    action: 'wearable_consent_sign',
    entity: 'wearable_consent',
    entityId: consent.id,
    detail: `Patient ${patientId} signed ${CONSENT_VERSION}; research=${allowResearch ? 'yes' : 'no'}`,
  });
  return consent;
}

/**
 * Begin connecting WHOOP. With live credentials, returns the WHOOP consent URL
 * and an OAuth `state` the caller must keep in the session. In demo mode, a
 * simulated device is connected and synced right away.
 */
export async function startWhoopConnect(
  patientId: number
): Promise<{ kind: 'redirect'; url: string; state: string } | { kind: 'connected'; synced: number }> {
  requireActiveConsent(patientId);
  if (isWhoopConfigured()) {
    const state = randomToken(16);
    return { kind: 'redirect', url: buildWhoopAuthorizeUrl(state), state };
  }
  saveWearableConnection({
    patientId,
    provider: WEARABLE_PROVIDER,
    mode: 'simulated',
    accessToken: null,
    refreshToken: null,
    tokenExpiresAt: null,
  });
  recordAudit({ actor: null, action: 'wearable_connect', entity: 'patient', entityId: patientId, detail: 'simulated' });
  return { kind: 'connected', synced: await syncPatientWearables(patientId) };
}

/** Finish the OAuth flow: check `state`, exchange the code, store tokens, sync. */
export async function completeWhoopConnect(
  patientId: number,
  params: { code?: unknown; state?: unknown; error?: unknown },
  expectedState: string | undefined
): Promise<number> {
  requireActiveConsent(patientId);
  if (typeof params.error === 'string' && params.error) {
    throw new ValidationError('WHOOP access was not granted, so nothing was connected.');
  }
  if (!expectedState || typeof params.state !== 'string' || params.state !== expectedState) {
    throw new ValidationError('That WHOOP sign-in link is no longer valid. Please start again.');
  }
  if (typeof params.code !== 'string' || !params.code) {
    throw new ValidationError('WHOOP did not return an authorization code. Please start again.');
  }
  const tokens = await exchangeWhoopCode(params.code);
  saveWearableConnection({ patientId, provider: WEARABLE_PROVIDER, mode: 'whoop', ...tokens });
  recordAudit({ actor: null, action: 'wearable_connect', entity: 'patient', entityId: patientId, detail: 'whoop oauth' });
  return syncPatientWearables(patientId);
}

/** Pull the latest data and store it de-identified. Returns days written. */
export async function syncPatientWearables(patientId: number): Promise<number> {
  requireActiveConsent(patientId);
  const conn = getWearableConnection(patientId);
  if (!conn) throw new ValidationError('Connect your WHOOP first.');
  const pseudonym = getOrCreatePseudonym(patientId);

  let records: DailyWearableRecord[];
  let source: string;
  if (conn.mode === 'simulated') {
    records = simulateWhoopDailyRecords(pseudonym, 14);
    source = SIMULATED_SOURCE;
  } else {
    if (!isWhoopConfigured()) throw new WhoopApiError('Live WHOOP sync is not set up on this server.');
    let accessToken = conn.accessToken;
    const expired = conn.tokenExpiresAt ? new Date(conn.tokenExpiresAt).getTime() - 60_000 <= Date.now() : false;
    if ((!accessToken || expired) && conn.refreshToken) {
      const fresh = await refreshWhoopTokens(conn.refreshToken);
      updateWearableTokens(patientId, fresh);
      accessToken = fresh.accessToken;
    }
    if (!accessToken) throw new WhoopApiError('Your WHOOP connection expired. Please connect again.');
    const since = new Date(Date.now() - LIVE_LOOKBACK_DAYS * 86400_000).toISOString();
    records = await fetchWhoopDailyRecords(accessToken, since);
    source = LIVE_SOURCE;
  }

  // Consent may have been withdrawn while the vendor call was in flight.
  if (!getActiveWearableConsent(patientId, WEARABLE_PROVIDER)) return 0;
  const written = upsertWearableObservations(pseudonym, source, records);
  markWearableSynced(patientId);
  recordAudit({ actor: null, action: 'wearable_sync', entity: 'patient', entityId: patientId, detail: `${written} day(s) from ${source}` });
  return written;
}

/** Withdraw: stop collection and delete the data plus the re-identification key. */
export function withdrawWearableConsent(patientId: number): void {
  const pseudonym = findPseudonymForPatient(patientId);
  const deleted = pseudonym ? deleteWearableObservations(pseudonym) : 0;
  deleteVaultEntry(patientId);
  deleteWearableConnection(patientId);
  withdrawWearableConsents(patientId, WEARABLE_PROVIDER);
  recordAudit({
    actor: null,
    action: 'wearable_consent_withdraw',
    entity: 'patient',
    entityId: patientId,
    detail: `Withdrawn; ${deleted} day(s) deleted and pseudonym destroyed`,
  });
}

// ---- Doctor side -------------------------------------------------------------

export interface WearableAverages extends WearableMetrics {
  days: number;
}

export interface DoctorWearableView {
  pseudonym: string;
  source: string | null;
  lastSyncedAt: string | null;
  observations: WearableObservation[];
  averages7d: WearableAverages;
}

function averages(rows: WearableObservation[]): WearableAverages {
  const out: any = { days: rows.length };
  for (const k of WEARABLE_METRIC_KEYS) {
    const vals = rows.map((r) => r[k]).filter((v): v is number => typeof v === 'number');
    out[k] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  }
  return out as WearableAverages;
}

/**
 * Wearable data for a patient under this doctor's care. Returns null when the
 * patient has not consented to sharing (or has no data yet). Throws
 * AccessDenied when the doctor has no qualifying relationship.
 */
export function getWearablesForDoctor(actor: Actor, patientId: number): DoctorWearableView | null {
  requireFeature(actor, 'wearables.doctor');
  assertDoctorCanReadHistory(actor, patientId);
  const consent = getActiveWearableConsent(patientId, WEARABLE_PROVIDER);
  const pseudonym = findPseudonymForPatient(patientId);
  if (!consent || !consent.shareWithDoctors || !pseudonym) return null;
  const observations = listWearableObservations(pseudonym, 14);
  recordAudit({ actor, action: 'wearable_read', entity: 'patient', entityId: patientId, detail: `${observations.length} day(s)` });
  return {
    pseudonym,
    source: observations[0]?.source ?? null,
    lastSyncedAt: getWearableConnection(patientId)?.lastSyncedAt ?? null,
    observations,
    averages7d: averages(observations.slice(0, 7)),
  };
}

// ---- De-identified research (ML) dataset -------------------------------------

/** One ML row: the pseudonym, a day index instead of a date, and the metrics. */
export interface ResearchRow extends WearableMetrics {
  subject: string;
  dayIndex: number;
}

/**
 * The de-identified dataset: only subjects with an active research opt-in.
 * Calendar dates are replaced by a day index relative to each subject's first
 * observation (date shifting), and the source/vendor fields are dropped.
 */
export function getResearchDataset(actor: Actor): { subjects: number; rows: ResearchRow[] } {
  requireFeature(actor, 'wearables.research');
  const pseudonyms = listResearchConsentPatientIds(WEARABLE_PROVIDER)
    .map((id) => findPseudonymForPatient(id))
    .filter((p): p is string => !!p)
    .sort();
  const firstDay = new Map<string, number>();
  const rows: ResearchRow[] = [];
  for (const o of listWearableObservationsFor(pseudonyms)) {
    const t = Date.parse(`${o.observedOn}T00:00:00Z`);
    if (!firstDay.has(o.pseudonym)) firstDay.set(o.pseudonym, t);
    const row: any = { subject: o.pseudonym, dayIndex: Math.round((t - firstDay.get(o.pseudonym)!) / 86400_000) };
    for (const k of WEARABLE_METRIC_KEYS) row[k] = o[k];
    rows.push(row as ResearchRow);
  }
  recordAudit({
    actor,
    action: 'wearable_research_read',
    entity: 'research_dataset',
    entityId: null,
    detail: `${firstDay.size} subject(s), ${rows.length} row(s)`,
  });
  return { subjects: firstDay.size, rows };
}

export function researchDatasetToCsv(rows: ResearchRow[]): string {
  const header = ['subject', 'day_index', ...WEARABLE_METRIC_KEYS];
  const lines = rows.map((r) =>
    [r.subject, r.dayIndex, ...WEARABLE_METRIC_KEYS.map((k) => (r[k] === null ? '' : r[k]))].join(',')
  );
  return [header.join(','), ...lines].join('\n') + '\n';
}

/**
 * The inverse lookup: map a research pseudonym back to a patient. Allowed only
 * for a doctor who already has a qualifying care relationship with that
 * patient, with a stated reason. Unknown pseudonyms and unrelated patients get
 * the same generic denial, so the lookup cannot be used to probe the vault.
 */
export function reidentifyResearchSubject(actor: Actor, pseudonymRaw: unknown, reasonRaw: unknown): number {
  requireFeature(actor, 'wearables.reidentify');
  const pseudonym = typeof pseudonymRaw === 'string' ? pseudonymRaw.trim().toUpperCase() : '';
  if (!PSEUDONYM_RE.test(pseudonym)) {
    throw new ValidationError('Enter a research code like WR- followed by 24 letters/digits.');
  }
  const reason = requireText(reasonRaw, 'Clinical reason');
  if (reason.length < 10) throw new ValidationError('Please describe the clinical reason (at least 10 characters).');

  const denied = new AccessDenied('You can only identify research subjects who are already under your care.');
  const patientId = resolvePseudonym(pseudonym);
  if (!patientId) {
    recordAudit({ actor, action: 'access_denied', entity: 'wearable_pseudonym', entityId: null, detail: 'reidentify: unknown code' });
    throw denied;
  }
  try {
    assertDoctorCanReadHistory(actor, patientId); // audits the denial itself
  } catch {
    throw denied;
  }
  recordAudit({
    actor,
    action: 'wearable_reidentify',
    entity: 'patient',
    entityId: patientId,
    detail: `Re-identified ${pseudonym}. Reason: ${reason.slice(0, 200)}`,
  });
  return patientId;
}
