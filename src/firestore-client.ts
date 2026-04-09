/**
 * Firestore Admin SDK initialisation.
 * Uses Application Default Credentials (ADC) — no credentials file needed on Cloud Run.
 */

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const app = initializeApp({
  credential: applicationDefault(),
  projectId: process.env.GCP_PROJECT_ID || "wayfinder-ai-fitness",
});

export const db = getFirestore(app);

/**
 * Allowed collections — app-level enforcement since Admin SDK
 * has project-level IAM only (no collection-level restrictions).
 */
const ALLOWED_COLLECTIONS = new Set([
  "research_cache",
  "pipeline_items",
  "feedback",
  "profiles",
  "engine_resources",
  "methodologies",
  "mcp_tokens",
  "mcp_feedback",
]);

export function assertAllowedCollection(collection: string): void {
  if (!ALLOWED_COLLECTIONS.has(collection)) {
    throw new Error(`Access denied: collection "${collection}" is not in the allowlist`);
  }
}

/**
 * Helper to get a user's profile subcollection reference.
 */
export function profileSubcollection(profileId: string, subcollection: string) {
  return db.collection("profiles").doc(profileId).collection(subcollection);
}

/**
 * Read active queue documents using profile.active_queues as source of truth.
 * Matches Flutter's training_tab_service.dart approach:
 *   profile.active_queues[].is_active === true -> load those queue docs only.
 *
 * PEL-220 fix: MCP tools were querying the raw queues subcollection and filtering
 * by status !== "archived", which returned stale/paused programs.
 */
export async function getActiveQueueDocuments(profileId: string): Promise<{
  profileData: Record<string, unknown>;
  queueDocs: FirebaseFirestore.DocumentSnapshot[];
}> {
  const profileSnap = await db.collection("profiles").doc(profileId).get();
  if (!profileSnap.exists) return { profileData: {}, queueDocs: [] };

  const profileData = profileSnap.data() as Record<string, unknown>;
  const activeQueues = (profileData.active_queues || []) as Array<Record<string, unknown>>;
  const activeRefs = activeQueues.filter((q) => q.is_active === true);

  if (activeRefs.length === 0) return { profileData, queueDocs: [] };

  const docs = await Promise.all(
    activeRefs.map((ref) =>
      profileSubcollection(profileId, "queues").doc(ref.queue_id as string).get(),
    ),
  );

  return { profileData, queueDocs: docs.filter((d) => d.exists) };
}
