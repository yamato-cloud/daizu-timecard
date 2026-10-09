/** 監査ログ（追記のみ）。全操作を記録する */
import { pool, type Queryable } from './db.js';

export interface Actor { kind: 'admin' | 'staff' | 'kiosk' | 'system'; id: string; label: string; ip?: string }

export const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'system', label: 'system' };

export async function audit(actor: Actor, action: string, target: string | null, before: unknown, after: unknown, client: Queryable = pool): Promise<void> {
  await client.query(
    'INSERT INTO audit_log (actor_kind, actor_id, actor_label, action, target, before, after, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [actor.kind, actor.id, actor.label, action, target, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), actor.ip ?? null],
  );
}
export function actorLabel(a: Actor): string { return `${a.kind}:${a.label || a.id}`; }
