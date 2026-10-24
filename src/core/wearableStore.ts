import { db, nowUtc } from './db';
import {
  decryptPII,
  encryptPII,
  openReid,
  randomPseudonym,
  reidIndex,
  sealReid,
} from './crypto';
import {
  WearableConnection,
  WearableConsent,
  WearableMetrics,
  WearableMode,
  WearableObservation,
  WearableProvider,
} from './types';

/**
 * Core data access for wearable data. Three separate stores, on purpose:
 *   1. consents + connections: identifiable (keyed by patient id), small.
 *   2. re-identification vault: pseudonym <-> patient, sealed with its own key.
 *   3. observations: de-identified measurements keyed ONLY by pseudonym.
 * Callers must authorize first; nothing here checks roles.
 */

// ---- Consents ---------------------------------------------------------------

function rowToConsent(row: any): WearableConsent {
  return {
    id: row.id,
    patientId: row.patient_id,
    provider: row.provider,
    consentVersion: row.consent_version,
    consentTextSha256: row.consent_text_sha256,
    signatureName: decryptPII(row.signature_name) ?? '',
    shareWithDoctors: !!row.share_with_doctors,
    allowResearch: !!row.allow_research,
    signedAt: row.signed_at,
    withdrawnAt: row.withdrawn_at,
  };
}

export function createWearableConsent(input: {
  patientId: number;
  provider: WearableProvider;
  consentVersion: string;
  consentTextSha256: string;
  signatureName: string;
  shareWithDoctors: boolean;
  allowResearch: boolean;
}): WearableConsent {
  const info = db
    .prepare(
      `INSERT INTO wearable_consents
         (patient_id, provider, consent_version, consent_text_sha256, signature_name,
          share_with_doctors, allow_research, signed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.patientId,
      input.provider,
      input.consentVersion,
      input.consentTextSha256,
      encryptPII(input.signatureName),
      input.shareWithDoctors ? 1 : 0,
      input.allowResearch ? 1 : 0,
      nowUtc()
    );
  return rowToConsent(db.prepare('SELECT * FROM wearable_consents WHERE id = ?').get(Number(info.lastInsertRowid)));
}

/** The patient's current (not withdrawn) consent for a provider, if any. */
export function getActiveWearableConsent(patientId: number, provider: WearableProvider): WearableConsent | null {
  const row = db
    .prepare(
      `SELECT * FROM wearable_consents
       WHERE patient_id = ? AND provider = ? AND withdrawn_at IS NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get(patientId, provider);
  return row ? rowToConsent(row) : null;
}

export function listWearableConsentsForPatient(patientId: number): WearableConsent[] {
  return (
    db.prepare('SELECT * FROM wearable_consents WHERE patient_id = ? ORDER BY id DESC').all(patientId) as any[]
  ).map(rowToConsent);
}

export function withdrawWearableConsents(patientId: number, provider: WearableProvider): void {
  db.prepare(
    'UPDATE wearable_consents SET withdrawn_at = ? WHERE patient_id = ? AND provider = ? AND withdrawn_at IS NULL'
  ).run(nowUtc(), patientId, provider);
}

/** Patient ids with an active consent that opts in to the research dataset. */
export function listResearchConsentPatientIds(provider: WearableProvider): number[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT patient_id FROM wearable_consents
         WHERE provider = ? AND withdrawn_at IS NULL AND allow_research = 1`
      )
      .all(provider) as any[]
  ).map((r) => r.patient_id);
}

// ---- Connections ------------------------------------------------------------

function rowToConnection(row: any): WearableConnection {
  return {
    id: row.id,
    patientId: row.patient_id,
    provider: row.provider,
    mode: row.mode,
    accessToken: decryptPII(row.access_token),
    refreshToken: decryptPII(row.refresh_token),
    tokenExpiresAt: row.token_expires_at,
    connectedAt: row.connected_at,
    lastSyncedAt: row.last_synced_at,
  };
}

export function getWearableConnection(patientId: number): WearableConnection | null {
  const row = db.prepare('SELECT * FROM wearable_connections WHERE patient_id = ?').get(patientId);
  return row ? rowToConnection(row) : null;
}

export function saveWearableConnection(input: {
  patientId: number;
  provider: WearableProvider;
  mode: WearableMode;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
}): WearableConnection {
  db.prepare(
    `INSERT INTO wearable_connections
       (patient_id, provider, mode, access_token, refresh_token, token_expires_at, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(patient_id) DO UPDATE SET
       provider = excluded.provider, mode = excluded.mode,
       access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       token_expires_at = excluded.token_expires_at, connected_at = excluded.connected_at`
  ).run(
    input.patientId,
    input.provider,
    input.mode,
    encryptPII(input.accessToken),
    encryptPII(input.refreshToken),
    input.tokenExpiresAt,
    nowUtc()
  );
  return getWearableConnection(input.patientId)!;
}

export function updateWearableTokens(
  patientId: number,
  tokens: { accessToken: string; refreshToken: string | null; tokenExpiresAt: string | null }
): void {
  db.prepare(
    'UPDATE wearable_connections SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE patient_id = ?'
  ).run(encryptPII(tokens.accessToken), encryptPII(tokens.refreshToken), tokens.tokenExpiresAt, patientId);
}

export function markWearableSynced(patientId: number): void {
  db.prepare('UPDATE wearable_connections SET last_synced_at = ? WHERE patient_id = ?').run(nowUtc(), patientId);
}

export function deleteWearableConnection(patientId: number): void {
  db.prepare('DELETE FROM wearable_connections WHERE patient_id = ?').run(patientId);
}

// ---- Re-identification vault -----------------------------------------------

function vaultIndex(patientId: number): string {
  return reidIndex(`patient:${patientId}`);
}

/** The patient's pseudonym, if one was issued. */
export function findPseudonymForPatient(patientId: number): string | null {
  const row = db
    .prepare('SELECT pseudonym FROM wearable_reid_vault WHERE patient_index = ?')
    .get(vaultIndex(patientId)) as any;
  return row ? row.pseudonym : null;
}

/** The patient's pseudonym, issuing a new random one on first use. */
export function getOrCreatePseudonym(patientId: number): string {
  const existing = findPseudonymForPatient(patientId);
  if (existing) return existing;
  const pseudonym = randomPseudonym();
  db.prepare(
    'INSERT INTO wearable_reid_vault (pseudonym, patient_index, patient_ref, created_at) VALUES (?, ?, ?, ?)'
  ).run(pseudonym, vaultIndex(patientId), sealReid(String(patientId)), nowUtc());
  return pseudonym;
}

/**
 * The inverse lookup: pseudonym -> patient id. Returns null for an unknown
 * pseudonym or a vault entry that fails to open (tampered / wrong key).
 */
export function resolvePseudonym(pseudonym: string): number | null {
  const row = db.prepare('SELECT patient_ref FROM wearable_reid_vault WHERE pseudonym = ?').get(pseudonym) as any;
  if (!row) return null;
  const opened = openReid(row.patient_ref);
  const id = opened ? Number(opened) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Remove the vault entry, making any remaining copies permanently unlinkable. */
export function deleteVaultEntry(patientId: number): void {
  db.prepare('DELETE FROM wearable_reid_vault WHERE patient_index = ?').run(vaultIndex(patientId));
}

// ---- De-identified observations --------------------------------------------

const METRIC_COLUMNS: Array<[keyof WearableMetrics, string]> = [
  ['restingHr', 'resting_hr'],
  ['avgHr', 'avg_hr'],
  ['maxHr', 'max_hr'],
  ['hrvMs', 'hrv_ms'],
  ['spo2Pct', 'spo2_pct'],
  ['skinTempC', 'skin_temp_c'],
  ['respiratoryRate', 'respiratory_rate'],
  ['systolicBp', 'systolic_bp'],
  ['diastolicBp', 'diastolic_bp'],
  ['sleepTotalMin', 'sleep_total_min'],
  ['sleepLightMin', 'sleep_light_min'],
  ['sleepDeepMin', 'sleep_deep_min'],
  ['sleepRemMin', 'sleep_rem_min'],
  ['sleepAwakeMin', 'sleep_awake_min'],
  ['sleepPerformancePct', 'sleep_performance_pct'],
  ['sleepEfficiencyPct', 'sleep_efficiency_pct'],
  ['recoveryScore', 'recovery_score'],
  ['strain', 'strain'],
];

function rowToObservation(row: any): WearableObservation {
  const obs: any = {
    id: row.id,
    pseudonym: row.pseudonym,
    source: row.source,
    observedOn: row.observed_on,
    ingestedAt: row.ingested_at,
  };
  for (const [key, col] of METRIC_COLUMNS) obs[key] = row[col] ?? null;
  return obs as WearableObservation;
}

/**
 * Insert or refresh de-identified daily rows. `sourceRecordId` (the vendor's
 * cycle id) is stored only as a keyed hash so the row can be de-duplicated on
 * re-sync but never matched back to the vendor account. Returns rows written.
 */
export function upsertWearableObservations(
  pseudonym: string,
  source: string,
  rows: Array<{ sourceRecordId: string; observedOn: string; metrics: WearableMetrics }>
): number {
  const cols = METRIC_COLUMNS.map(([, c]) => c);
  const stmt = db.prepare(
    `INSERT INTO wearable_observations (pseudonym, source, source_key, observed_on, ${cols.join(', ')}, ingested_at)
     VALUES (?, ?, ?, ?, ${cols.map(() => '?').join(', ')}, ?)
     ON CONFLICT(pseudonym, source_key) DO UPDATE SET
       observed_on = excluded.observed_on,
       ${cols.map((c) => `${c} = excluded.${c}`).join(', ')},
       ingested_at = excluded.ingested_at`
  );
  const write = db.transaction(() => {
    for (const r of rows) {
      stmt.run(
        pseudonym,
        source,
        reidIndex(`${source}:${r.sourceRecordId}`),
        r.observedOn,
        ...METRIC_COLUMNS.map(([k]) => r.metrics[k]),
        nowUtc()
      );
    }
  });
  write();
  return rows.length;
}

/** Observations for one pseudonym, newest first, optionally limited. */
export function listWearableObservations(pseudonym: string, limit?: number): WearableObservation[] {
  const rows = limit
    ? db
        .prepare('SELECT * FROM wearable_observations WHERE pseudonym = ? ORDER BY observed_on DESC LIMIT ?')
        .all(pseudonym, limit)
    : db.prepare('SELECT * FROM wearable_observations WHERE pseudonym = ? ORDER BY observed_on DESC').all(pseudonym);
  return (rows as any[]).map(rowToObservation);
}

/** Observations for many pseudonyms, ordered for dataset export. */
export function listWearableObservationsFor(pseudonyms: string[]): WearableObservation[] {
  if (pseudonyms.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT * FROM wearable_observations WHERE pseudonym IN (${pseudonyms.map(() => '?').join(', ')})
       ORDER BY pseudonym, observed_on`
    )
    .all(...pseudonyms);
  return (rows as any[]).map(rowToObservation);
}

export function deleteWearableObservations(pseudonym: string): number {
  return db.prepare('DELETE FROM wearable_observations WHERE pseudonym = ?').run(pseudonym).changes;
}
