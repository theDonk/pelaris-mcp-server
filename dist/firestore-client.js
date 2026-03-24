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
]);
export function assertAllowedCollection(collection) {
    if (!ALLOWED_COLLECTIONS.has(collection)) {
        throw new Error(`Access denied: collection "${collection}" is not in the allowlist`);
    }
}
//# sourceMappingURL=firestore-client.js.map