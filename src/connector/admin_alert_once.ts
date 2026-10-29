/**
 * Raise one `admin_alerts` doc per category per UTC day: the create-once pattern the gateway's
 * refused-registration alert uses (`dcr_guard.ts` `raiseConnectorDcrRefusedAlertOnce`, the same
 * doc id and shape as wayfinder's `buildAdminAlertData`). `create` fails with ALREADY_EXISTS
 * (code 6) when another instance or registrar raised it first; that is success, not an error.
 * Each instance also remembers the day it raised, so a busy instance writes at most once a day.
 * Never throws.
 *
 * MCP_FIXES.md 1.6 (connector latency, 29/10/2026). `dcr_guard.ts` can move onto this helper
 * once its open PRs (#10, #11) have merged; it is left alone here to keep those PRs conflict-free.
 */
import { Timestamp, type Firestore } from "firebase-admin/firestore";

const raisedDayByCategory = new Map<string, string>();

export function adminAlertDocId(category: string, now: Date): string {
  return `${category}_${now.toISOString().slice(0, 10)}`;
}

export async function raiseAdminAlertOncePerDay(
  db: Pick<Firestore, "collection">,
  alert: { category: string; severity: "warn" | "critical"; details: Record<string, unknown> },
  now: Date = new Date(),
): Promise<boolean> {
  const day = now.toISOString().slice(0, 10);
  if (raisedDayByCategory.get(alert.category) === day) return false;
  raisedDayByCategory.set(alert.category, day);
  try {
    await db.collection("admin_alerts").doc(adminAlertDocId(alert.category, now)).create({
      severity: alert.severity,
      category: alert.category,
      details: alert.details,
      resolved_at: null,
      resolved_by_uid: null,
      created_at: Timestamp.fromDate(now),
    });
    return true;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 6) {
      raisedDayByCategory.delete(alert.category);
      console.warn(JSON.stringify({
        event: "admin_alert_write_failed",
        category: alert.category,
        error: error instanceof Error ? error.message.slice(0, 120) : "unknown",
      }));
    }
    return false;
  }
}

export function __resetAdminAlertOnceForTest(): void {
  raisedDayByCategory.clear();
}
