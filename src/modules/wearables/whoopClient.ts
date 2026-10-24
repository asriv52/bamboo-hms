import crypto from 'crypto';
import { config } from '../../core/config';
import { WearableMetrics } from '../../core/types';

/**
 * WHOOP adapter. Two sources produce the same daily record shape:
 *   - the live WHOOP Developer API v2 (OAuth 2.0 authorization-code flow), used
 *     when WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET are configured;
 *   - a simulator that generates synthetic data, used otherwise (demo mode).
 *
 * The adapter only returns measurements. Vendor identifiers (WHOOP user id,
 * email, name) are never read or passed on. The cycle id is returned as
 * `sourceRecordId` so the store can de-duplicate; the store keeps only a keyed
 * hash of it.
 *
 * Blood pressure: the public WHOOP API does not expose blood pressure, so live
 * records leave systolic/diastolic null. The simulator fills them so the demo
 * shows how cuff or BP-insight readings would flow through the same pipeline.
 */

export interface DailyWearableRecord {
  sourceRecordId: string;
  observedOn: string; // YYYY-MM-DD (UTC)
  metrics: WearableMetrics;
}

export interface WhoopTokens {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
}

export class WhoopApiError extends Error {
  constructor(message = 'We could not reach WHOOP right now. Please try again later.') {
    super(message);
    this.name = 'WhoopApiError';
  }
}

const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API_BASE = 'https://api.prod.whoop.com/developer';
// `offline` returns a refresh token. Profile / body-measurement scopes are
// deliberately NOT requested: we never need the member's name or email.
const SCOPES = 'offline read:recovery read:cycles read:sleep';
const TIMEOUT_MS = 10_000;
const MAX_PAGES = 4; // 25 records per page

export function isWhoopConfigured(): boolean {
  return !!(config.whoop.clientId && config.whoop.clientSecret);
}

export function buildWhoopAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.whoop.clientId,
    redirect_uri: config.whoop.redirectUri,
    scope: SCOPES,
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(body: Record<string, string>): Promise<WhoopTokens> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...body,
        client_id: config.whoop.clientId,
        client_secret: config.whoop.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error('[whoop] token request failed', err);
    throw new WhoopApiError();
  }
  if (!res.ok) {
    console.error('[whoop] token request rejected', res.status);
    throw new WhoopApiError('WHOOP did not accept the connection. Please try connecting again.');
  }
  const json = (await res.json()) as any;
  if (typeof json.access_token !== 'string') throw new WhoopApiError();
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    tokenExpiresAt:
      typeof json.expires_in === 'number' ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
  };
}

export function exchangeWhoopCode(code: string): Promise<WhoopTokens> {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.whoop.redirectUri });
}

export function refreshWhoopTokens(refreshToken: string): Promise<WhoopTokens> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: 'offline' });
}

async function getCollection(accessToken: string, path: string, startIso: string): Promise<any[]> {
  const out: any[] = [];
  let nextToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: '25', start: startIso });
    if (nextToken) params.set('nextToken', nextToken);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      console.error('[whoop] fetch failed', path, err);
      throw new WhoopApiError();
    }
    if (res.status === 401) throw new WhoopApiError('Your WHOOP connection expired. Please connect again.');
    if (!res.ok) {
      console.error('[whoop] fetch rejected', path, res.status);
      throw new WhoopApiError();
    }
    const json = (await res.json()) as any;
    if (Array.isArray(json.records)) out.push(...json.records);
    nextToken = typeof json.next_token === 'string' && json.next_token ? json.next_token : null;
    if (!nextToken) break;
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const minutes = (ms: unknown): number | null => (num(ms) === null ? null : Math.round((ms as number) / 60000));
const round1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

/**
 * Pull scored cycles, recoveries, and (non-nap) sleeps since `startIso` and
 * merge them into one record per physiological cycle (≈ one per day).
 */
export async function fetchWhoopDailyRecords(accessToken: string, startIso: string): Promise<DailyWearableRecord[]> {
  const [cycles, recoveries, sleeps] = await Promise.all([
    getCollection(accessToken, '/v2/cycle', startIso),
    getCollection(accessToken, '/v2/recovery', startIso),
    getCollection(accessToken, '/v2/activity/sleep', startIso),
  ]);

  const recoveryByCycle = new Map<string, any>();
  for (const r of recoveries) if (r.score_state === 'SCORED') recoveryByCycle.set(String(r.cycle_id), r.score);
  const sleepByCycle = new Map<string, any>();
  for (const s of sleeps) if (s.score_state === 'SCORED' && !s.nap) sleepByCycle.set(String(s.cycle_id), s.score);

  const out: DailyWearableRecord[] = [];
  for (const c of cycles) {
    if (typeof c.start !== 'string') continue;
    const id = String(c.id);
    const cycle = c.score_state === 'SCORED' ? c.score ?? {} : {};
    const rec = recoveryByCycle.get(id) ?? {};
    const slp = sleepByCycle.get(id) ?? {};
    const stages = slp.stage_summary ?? {};
    const light = minutes(stages.total_light_sleep_time_milli);
    const deep = minutes(stages.total_slow_wave_sleep_time_milli);
    const rem = minutes(stages.total_rem_sleep_time_milli);
    out.push({
      sourceRecordId: id,
      observedOn: c.start.slice(0, 10),
      metrics: {
        restingHr: num(rec.resting_heart_rate),
        avgHr: num(cycle.average_heart_rate),
        maxHr: num(cycle.max_heart_rate),
        hrvMs: round1(num(rec.hrv_rmssd_milli)),
        spo2Pct: round1(num(rec.spo2_percentage)),
        skinTempC: round1(num(rec.skin_temp_celsius)),
        respiratoryRate: round1(num(slp.respiratory_rate)),
        systolicBp: null, // not exposed by the WHOOP public API
        diastolicBp: null,
        sleepTotalMin: light !== null && deep !== null && rem !== null ? light + deep + rem : null,
        sleepLightMin: light,
        sleepDeepMin: deep,
        sleepRemMin: rem,
        sleepAwakeMin: minutes(stages.total_awake_time_milli),
        sleepPerformancePct: num(slp.sleep_performance_percentage),
        sleepEfficiencyPct: round1(num(slp.sleep_efficiency_percentage)),
        recoveryScore: num(rec.recovery_score),
        strain: round1(num(cycle.strain)),
      },
    });
  }
  return out;
}

// ---- Simulator (demo mode) ---------------------------------------------------

/** Deterministic 0..1 value for a key, so re-syncing the same day is stable. */
function unit(key: string): number {
  return crypto.createHash('sha256').update(key).digest().readUInt32BE(0) / 0xffffffff;
}

/**
 * Synthetic health profiles for demo / ML test data. Each shifts the subject's
 * baseline so the dataset has distinguishable patterns to learn from.
 */
export type SimulatedProfile = 'typical' | 'athletic' | 'hypertensive' | 'poorSleep' | 'lowRecovery';

const PROFILE_SHIFT: Record<SimulatedProfile, { rhr: number; hrv: number; sys: number; dia: number; sleep: number }> = {
  typical: { rhr: 0, hrv: 0, sys: 0, dia: 0, sleep: 0 },
  athletic: { rhr: -8, hrv: 25, sys: -6, dia: -4, sleep: 20 },
  hypertensive: { rhr: 8, hrv: -12, sys: 28, dia: 14, sleep: -15 },
  poorSleep: { rhr: 5, hrv: -10, sys: 4, dia: 3, sleep: -110 },
  lowRecovery: { rhr: 10, hrv: -22, sys: 6, dia: 4, sleep: -40 },
};

/**
 * Synthetic WHOOP-like daily records for the last `days` days. `seedKey` makes
 * each subject's baseline different but stable. No real data is involved.
 */
export function simulateWhoopDailyRecords(
  seedKey: string,
  days = 14,
  profile: SimulatedProfile = 'typical'
): DailyWearableRecord[] {
  const s = PROFILE_SHIFT[profile];
  const base = {
    rhr: 52 + unit(`${seedKey}:rhr`) * 18 + s.rhr,
    hrv: Math.max(12, 35 + unit(`${seedKey}:hrv`) * 55 + s.hrv),
    sys: 110 + unit(`${seedKey}:sys`) * 28 + s.sys,
    dia: 70 + unit(`${seedKey}:dia`) * 16 + s.dia,
    sleep: Math.max(220, 380 + unit(`${seedKey}:sleep`) * 90 + s.sleep),
  };
  const out: DailyWearableRecord[] = [];
  for (let d = days; d >= 1; d--) {
    const day = new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);
    const k = (m: string) => unit(`${seedKey}:${day}:${m}`) - 0.5; // -0.5..0.5
    const total = Math.round(base.sleep + k('sleep') * 80);
    const deep = Math.round(total * (0.18 + k('deep') * 0.06));
    const rem = Math.round(total * (0.22 + k('rem') * 0.06));
    const hrv = Math.round((base.hrv + k('hrv') * 20) * 10) / 10;
    const recovery = Math.max(5, Math.min(99, Math.round(35 + (hrv - 30) * 0.9 + k('rec') * 20)));
    out.push({
      sourceRecordId: `sim:${seedKey}:${day}`,
      observedOn: day,
      metrics: {
        restingHr: Math.round(base.rhr + k('rhr') * 6),
        avgHr: Math.round(base.rhr + 14 + k('avg') * 8),
        maxHr: Math.round(140 + k('max') * 50),
        hrvMs: hrv,
        spo2Pct: Math.round((97 + k('spo2') * 3) * 10) / 10,
        skinTempC: Math.round((33.6 + k('temp') * 1.2) * 10) / 10,
        respiratoryRate: Math.round((15 + k('resp') * 3) * 10) / 10,
        systolicBp: Math.round(base.sys + k('sys') * 10),
        diastolicBp: Math.round(base.dia + k('dia') * 8),
        sleepTotalMin: total,
        sleepLightMin: total - deep - rem,
        sleepDeepMin: deep,
        sleepRemMin: rem,
        sleepAwakeMin: Math.round(25 + k('awake') * 30),
        sleepPerformancePct: Math.max(40, Math.min(100, Math.round(85 + k('perf') * 30))),
        sleepEfficiencyPct: Math.round((90 + k('eff') * 10) * 10) / 10,
        recoveryScore: recovery,
        strain: Math.round((10 + k('strain') * 12) * 10) / 10,
      },
    });
  }
  return out;
}
