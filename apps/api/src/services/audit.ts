import { auditLog, type DbOrTx } from "@aix/db";
import { newId } from "@aix/core";

export interface AuditInput {
  actorUserId?: string | null;
  actorType: "user" | "developer" | "admin" | "system" | "gateway";
  orgId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  /** Never put conversation content, secrets or tokens here. */
  metadata?: Record<string, unknown>;
}

export async function audit(db: DbOrTx, a: AuditInput) {
  await db.insert(auditLog).values({
    id: newId("aud"),
    actorUserId: a.actorUserId ?? null,
    actorType: a.actorType,
    orgId: a.orgId ?? null,
    action: a.action,
    targetType: a.targetType ?? null,
    targetId: a.targetId ?? null,
    metadata: a.metadata ?? {},
  });
}
