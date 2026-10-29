/**
 * The return hook before a DIRECT tool (Pelaris 1.4 B2a lane C, C6 h; B1R
 * `return_check` contract; panel P1-04, P2-5, P5-4).
 *
 * CS4 call site of FL-2 C4.5/C4.6 via B1R return_check, Brad-approved
 * 08/10/2026 (HANDOFF §2; DECISIONS 18), built by B1R 09/10/2026; B2a adds no
 * CS4 logic.
 *
 * A plan rested by the 21-day rule comes back on any sign of return. Tools
 * that go through wayfinder's `coreToolsBridge` already get B1R's return step
 * there; the gateway's DIRECT tools read Firestore themselves and keep only
 * `is_active === true` entries (`firestore-client.ts` getActiveQueueDocuments),
 * so a rested plan read "No active program" on the first call. Now, only for a
 * `tools/call` of a direct tool (never `initialize`, `tools/list` or a bridged
 * tool), when the vendored predicates say there may be work, the gateway
 * calls B1R's `return_check` through the bridge, bounded by the
 * `bridge_return_step_timeout_ms` dial, and then the tool reads the resumed
 * plan itself. An empty answer is cached per instance per profile for
 * `connector_use_stamp_minutes`. A timeout or failure runs the tool as today
 * with one log line. The gateway NEVER writes `last_connector_use_at`: the one
 * writer is `return_check` (it stamps when due).
 *
 * The two predicates are VENDORED from wayfinder (`services/plan_return.ts`
 * `mayHaveReturnWork(profile, "resting")`, `utils/plan_state.ts`,
 * `services/return_signals.ts` `connectorStampDue`, `utils/session_done.ts`
 * `timeMsOf`) and pinned to the shared case table
 * `test_fixtures/gateway_return_predicate_cases.json`. The plan-state readers
 * (`planEntriesOf`, `planEntryQueueId`, `isManualEntry`, `planStateOf`,
 * `hasPlan`) are exported so the program tools read the app's rule from this
 * one pinned copy instead of keeping another (connector rev 2.1, M1); `hasPlan`
 * has its own `has_plan` table in the same fixture.
 */

/** Canonical SHA-256 of `test_fixtures/gateway_return_predicate_cases.json` (equal to wayfinder's). */
export const GATEWAY_RETURN_PREDICATE_CASES_SHA256 = "3a43f340893e46f947af6a5e6f97f3bd28c16910eb05c2ae2d8fee2a216304ac";

type Raw = Readonly<Record<string, unknown>>;

const RESTING_PAUSE_REASON = "inactive_21_days";

export function isSet(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

export function planEntriesOf(profile: Raw | null | undefined): Raw[] {
  const raw = profile?.["active_queues"];
  if (!Array.isArray(raw)) return [];
  const entries: Raw[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim().length > 0) entries.push({ queue_id: item.trim() });
    else if (item != null && typeof item === "object" && !Array.isArray(item)) entries.push(item as Raw);
  }
  return entries;
}

export function planEntryQueueId(entry: Raw): string | null {
  for (const key of ["queue_id", "id"]) {
    const value = entry[key];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    return value.includes("/") ? null : value.trim();
  }
  return null;
}

export function isManualEntry(entry: Raw): boolean {
  return entry["methodology_id"] === "manual" ||
    entry["program_id"] === "manual" ||
    planEntryQueueId(entry) === "manual_workouts";
}

export type PlanState = "active" | "resting" | "paused_by_person" | "retired";

export function planStateOf(entry: Raw): PlanState {
  if (isSet(entry["retired_at"]) || isSet(entry["superseded_by"]) || isSet(entry["removed_at"])) return "retired";
  if (entry["is_active"] !== false) return "active";
  return entry["pause_reason"] === RESTING_PAUSE_REASON ? "resting" : "paused_by_person";
}

/**
 * Vendored `hasPlan` (wayfinder `utils/plan_state.ts`): the person has a plan when any entry that is
 * not the manual-workouts container is not retired. A rested plan and a plan the person paused are
 * still plans. Connector rev 2.1 (M1, 22/10/2026): the ONE connector reading of "does this athlete
 * have a program", shared by `generate_program` and `get_onboarding_status` and pinned to the
 * `has_plan` table of the shared case table, so it cannot drift from the app's rule.
 */
export function hasPlan(profile: Raw | null | undefined): boolean {
  return planEntriesOf(profile).some((entry) => !isManualEntry(entry) && planStateOf(entry) !== "retired");
}

function needsRestEvidence(entry: Raw): boolean {
  return planStateOf(entry) === "paused_by_person" && !isSet(entry["pause_reason"]);
}

/**
 * Vendored `mayHaveReturnWork(profile, "resting")`: the newest non-manual,
 * non-retired plan (any family, by array position) is resting by its mirror,
 * or inactive with no reason at all (its queue may carry rest evidence). An
 * entry with no queue id is still the newest (it blocks older plans) but is
 * never acted on.
 */
export function mayHaveReturnWorkResting(profile: Raw | null | undefined): boolean {
  const entries = planEntriesOf(profile);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isManualEntry(entry)) continue;
    const state = planStateOf(entry);
    if (state === "retired") continue;
    if (planEntryQueueId(entry) == null) return false;
    return state === "resting" || needsRestEvidence(entry);
  }
  return false;
}

/** Vendored `timeMsOf` (wayfinder `utils/session_done.ts`). */
export function timeMsOf(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "string") {
    if (value.trim().length === 0) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object["toMillis"] === "function") {
      const ms = (object["toMillis"] as () => unknown)();
      return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
    }
    if (typeof object["toDate"] === "function") return timeMsOf((object["toDate"] as () => unknown)());
    const seconds = typeof object["seconds"] === "number" ? object["seconds"] :
      typeof object["_seconds"] === "number" ? object["_seconds"] : null;
    if (seconds != null && Number.isFinite(seconds)) {
      const nanos = typeof object["nanoseconds"] === "number" ? object["nanoseconds"] :
        typeof object["_nanoseconds"] === "number" ? object["_nanoseconds"] : 0;
      return (seconds as number) * 1000 + Math.floor((nanos as number) / 1e6);
    }
  }
  return null;
}

/** Vendored `connectorStampDue`: absent, unreadable, or older than the dial. */
export function connectorStampDue(profile: Raw | null | undefined, nowMs: number, stampMinutes: number): boolean {
  const lastMs = timeMsOf(profile?.["last_connector_use_at"]);
  return lastMs == null || nowMs - lastMs >= stampMinutes * 60_000;
}

// ── Which calls get the hook ────────────────────────────────────────────────

/**
 * Tools whose handler goes entirely through `coreToolsBridge` (no direct
 * Firestore read), so B1R's bridge-side return step already runs for them.
 * Every other tool, including any added later, is direct. Pinned against the
 * tool sources by `return_hook.test.ts`.
 */
export const BRIDGED_TOOLS: ReadonlySet<string> = new Set([
  "complete_intake",
  "create_planned_session",
  "log_completed_session",
  "log_workout",
  "manage_program",
  "modify_training_session",
  "resolve_exercise_ids",
  "swap_exercise",
  "update_session",
]);

/**
 * Every tool the gateway registers for an OAuth caller (index.ts). Only these
 * names can trigger the hook or appear in its log lines; a caller-chosen
 * string never does. Pinned against the registrations by return_hook.test.ts.
 */
export const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  "complete_intake", "create_planned_session", "daily_check_in", "delete_session", "delete_sessions",
  "generate_program", "get_active_program", "get_benchmarks", "get_body_analysis", "get_coach_insight",
  "get_onboarding_status", "get_program_status", "get_session_details", "get_training_overview",
  "get_weekly_debrief", "list_goals", "log_completed_session", "log_workout", "manage_goals",
  "manage_program", "modify_training_session", "record_benchmark", "record_injury", "resolve_exercise_ids",
  "search_training_resources", "send_feedback", "swap_exercise", "update_profile", "update_session",
]);

/** The direct tools a JSON-RPC body (one message or a batch) calls. */
export function directToolCalls(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const names: string[] = [];
  for (const message of messages) {
    if (message == null || typeof message !== "object") continue;
    const m = message as { method?: unknown; params?: { name?: unknown } };
    if (m.method !== "tools/call") continue;
    const name = m.params?.name;
    if (typeof name === "string" && KNOWN_TOOLS.has(name) && !BRIDGED_TOOLS.has(name)) names.push(name);
  }
  return names;
}

// ── The hook ────────────────────────────────────────────────────────────────

export type ReturnHookOutcome =
  | "not_direct"
  | "cached_empty"
  | "backoff"
  | "no_work"
  | "empty"
  | "resumed"
  | "failed"
  | "timed_out"
  /** Only the presence stamp was due: return_check runs in the background, the tool does not wait. */
  | "stamp_async";

export type BridgeCall = (tool: string, profileId: string, input: Record<string, unknown>) =>
  Promise<{ ok: boolean; result?: unknown; error?: string }>;

const MAX_CACHE_ENTRIES = 5000;
/** After a failed or timed-out bridge call, skip the hook for this long per profile (CR-11). */
export const FAILURE_BACKOFF_MS = 5 * 60_000;
const emptyUntil = new Map<string, number>();
const failedUntil = new Map<string, number>();
/** Profiles whose background stamp call has not landed yet (MCP_FIXES.md §1.6). */
const stampInFlight = new Set<string>();
/**
 * Back-off after a failed BACKGROUND stamp, checked only on the stamp path. A background call can
 * finish late or be reset while the instance is CPU-throttled between requests; that must never
 * skip the awaited resume of a rested plan (panel, SRE + pragmatist).
 */
const stampFailedUntil = new Map<string, number>();

function cacheUntil(cache: Map<string, number>, profileId: string, untilMs: number, nowMs: number): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    for (const [key, until] of cache) if (until <= nowMs) cache.delete(key);
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  }
  cache.set(profileId, untilMs);
}

function prefix(id: string): string {
  return id.slice(0, 6);
}

function logHook(event: string, fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ severity: "INFO", event, ...fields }) + "\n");
}

/**
 * Run B1R's return check before a direct tool when the profile may have work.
 * Never throws; the tool runs whatever happens here.
 */
export async function runReturnHook(args: {
  profileId: string;
  profileData: Raw;
  tools: readonly string[];
  bridge: BridgeCall;
  stampMinutes: number;
  timeoutMs: number;
  nowMs?: number;
}): Promise<ReturnHookOutcome> {
  if (args.tools.length === 0) return "not_direct";
  const nowMs = args.nowMs ?? Date.now();
  const cachedUntil = emptyUntil.get(args.profileId);
  if (cachedUntil != null && cachedUntil > nowMs) return "cached_empty";
  const backoffUntil = failedUntil.get(args.profileId);
  if (backoffUntil != null && backoffUntil > nowMs) return "backoff";
  const mayResume = mayHaveReturnWorkResting(args.profileData);
  if (!mayResume && !connectorStampDue(args.profileData, nowMs, args.stampMinutes)) {
    return "no_work";
  }
  if (!mayResume) {
    if (stampInFlight.has(args.profileId)) return "stamp_async";
    const stampBackoff = stampFailedUntil.get(args.profileId);
    if (stampBackoff != null && stampBackoff > nowMs) return "backoff";
  }
  const call = callReturnCheck(args.bridge, args.profileId);
  if (!mayResume) {
    // MCP_FIXES.md §1.6: only the presence stamp is due and no rested plan can resume (the
    // vendored predicate says so), so the tool does not wait. The empty answer is still cached and
    // a failure backs off only this path, when it lands. Two accepted residuals (§1.6): if the
    // instance is throttled or stops first, the stamp stays due and the next call retries; and a
    // stamp that writes widens wayfinder's scope to resting_and_stale, so an ACTIVE plan with
    // Profile Resume evidence may shift on the bridge after this tool read pre-shift dates once.
    // One background call per profile per instance at a time.
    stampInFlight.add(args.profileId);
    void call
      .then((winner) => settle(winner, args, nowMs, stampFailedUntil))
      .catch(() => undefined) // a throw while settling (a broken stdout) must never become an unhandled rejection
      .finally(() => stampInFlight.delete(args.profileId));
    return "stamp_async";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), args.timeoutMs);
  });
  const winner = await Promise.race([call, timeout]);
  if (timer) clearTimeout(timer);
  if (winner === "timed_out") {
    logHook("gateway_return_check_timed_out", { profile: prefix(args.profileId), tool: args.tools[0], timeout_ms: args.timeoutMs });
    // CR-11: a hung bridge answers late, not never, and the losing call runs on for up to its own
    // 120 s. Back off like a failure so every direct call from a due profile does not wait the
    // full dial and start another long request.
    cacheUntil(failedUntil, args.profileId, nowMs + FAILURE_BACKOFF_MS, nowMs);
    return "timed_out";
  }
  return settle(winner, args, nowMs);
}

type CallOutcome =
  | { outcome: "failed"; error: string }
  | { outcome: "empty"; count: number }
  | { outcome: "resumed"; count: number };

/** One `return_check` bridge call. Never rejects. */
function callReturnCheck(bridge: BridgeCall, profileId: string): Promise<CallOutcome> {
  // B2a fix pass (CR-10): `.then(onOk).catch(onErr)`, not `.then(onOk, onErr)`. The two-argument form
  // does not catch a throw inside onOk, so a malformed reply (a null body: `envelope.ok` throws) made
  // `call` reject, and a rejection that lands after the timeout won the race had no handler at all.
  // The error text is a closed code: never the reply's or the error's own words.
  return Promise.resolve().then(() => bridge("return_check", profileId, {})).then(
    (envelope) => {
      if (envelope == null || typeof envelope !== "object") return { outcome: "failed" as const, error: "malformed_reply" };
      if (!envelope.ok) return { outcome: "failed" as const, error: String(envelope.error ?? "not_ok").slice(0, 64) };
      const resumed = (envelope.result as { resumed_queue_ids?: unknown } | undefined)?.resumed_queue_ids;
      const count = Array.isArray(resumed) ? resumed.length : 0;
      return { outcome: count > 0 ? "resumed" as const : "empty" as const, count };
    },
  ).catch((error: unknown) => ({ outcome: "failed" as const, error: (error instanceof Error ? error.message : String(error)).slice(0, 64) }));
}

/** Cache an empty answer, log a resume, back off after a failure. */
function settle(
  winner: CallOutcome,
  args: { profileId: string; tools: readonly string[]; stampMinutes: number },
  nowMs: number,
  failureBackoff: Map<string, number> = failedUntil,
): "empty" | "resumed" | "failed" {
  if (winner.outcome === "empty") {
    cacheUntil(emptyUntil, args.profileId, nowMs + args.stampMinutes * 60_000, nowMs);
    return "empty";
  }
  if (winner.outcome === "resumed") {
    logHook("gateway_return_check_resumed", { profile: prefix(args.profileId), tool: args.tools[0], plans: winner.count });
    return "resumed";
  }
  logHook("gateway_return_check_failed", { profile: prefix(args.profileId), tool: args.tools[0], error: winner.error });
  cacheUntil(failureBackoff, args.profileId, nowMs + FAILURE_BACKOFF_MS, nowMs);
  return "failed";
}

export function __resetReturnHookCacheForTest(): void {
  emptyUntil.clear();
  failedUntil.clear();
  stampInFlight.clear();
  stampFailedUntil.clear();
}
