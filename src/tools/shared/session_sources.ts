/**
 * Where a session's data came from, for get_session_details.
 *
 * Read from the diary's `linked_imported_sources[]` entries, for every provider (no filter), so an
 * assistant can name the app and the recording device. This mirrors the core tool's
 * `sessionSourcesFromLinkedEntries` in the wayfinder repository (this repo cannot import it), so a
 * diary-resident session and a bridged one answer with the same list. Change both together.
 *
 * - The primary source comes first; the rest keep their stored order.
 * - One row per provider and device.
 * - `deviceName` is null when the entry names no device (older entries have no field at all).
 * - A diary without the array has no sources: an empty list.
 */

export interface SessionSource {
  /** The integration that delivered the data ("garmin", "strava", "polar", ...). */
  provider: string;
  /** The recording device, formatted for display ("Garmin Forerunner 965"), or null. */
  deviceName: string | null;
}

export function sessionSourcesFromLinkedEntries(linked: unknown): SessionSource[] {
  if (!Array.isArray(linked)) return [];
  const entries = linked.filter((e): e is Record<string, unknown> =>
    e !== null && typeof e === "object" && !Array.isArray(e) &&
    typeof (e as Record<string, unknown>).provider === "string" &&
    ((e as Record<string, unknown>).provider as string).trim().length > 0);
  const ordered = [...entries.filter((e) => e.isPrimary === true), ...entries.filter((e) => e.isPrimary !== true)];
  const seen = new Set<string>();
  const out: SessionSource[] = [];
  for (const e of ordered) {
    const provider = (e.provider as string).trim();
    const device = typeof e.deviceName === "string" ? e.deviceName.trim() : "";
    const deviceName = device.length > 0 ? device : null;
    const key = JSON.stringify([provider, deviceName]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, deviceName });
  }
  return out;
}
