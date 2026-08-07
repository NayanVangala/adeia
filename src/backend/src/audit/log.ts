import type { Db } from "../db/client.ts";
import { insertAuditEvent } from "../db/repo.ts";

/**
 * The only writer of `audit_events`. Append-only: no UPDATE, no DELETE. If a
 * record turns out to be wrong, append a correcting event.
 *
 * Phase 6 narrows `event` to a union of known names and adds write-time
 * redaction of `data`. Until then the contract is: nothing secret goes in.
 */
export function appendAudit(
  db: Db,
  e: { actionId?: string; projectId: string; event: string; data?: unknown },
): void {
  insertAuditEvent(db, {
    actionId: e.actionId ?? null,
    projectId: e.projectId,
    event: e.event,
    data: e.data === undefined ? null : JSON.stringify(e.data),
  });
}
