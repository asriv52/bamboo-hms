import { db, nowUtc } from './db';
import { Actor, AuditRecord } from './types';

/**
 * Immutable audit log. Every mutation appends a record. There is no update or
 * delete API — records are append-only.
 */
export function recordAudit(params: {
  actor: Actor | null;
  action: string;
  entity: string;
  entityId: number | null;
  detail?: string;
}): void {
  db.prepare(
    `INSERT INTO audit_records (actor_id, actor_role, action, entity, entity_id, detail, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.actor?.userId ?? null,
    params.actor?.activeRole ?? null,
    params.action,
    params.entity,
    params.entityId,
    params.detail ?? null,
    nowUtc()
  );
}

export function listAudit(limit = 100): AuditRecord[] {
  return db
    .prepare(
      `SELECT id, actor_id as actorId, actor_role as actorRole, action,
              entity, entity_id as entityId, detail, at
       FROM audit_records ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as AuditRecord[];
}
