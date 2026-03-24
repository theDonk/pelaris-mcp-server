/**
 * Firestore Admin SDK initialisation.
 * Uses Application Default Credentials (ADC) — no credentials file needed on Cloud Run.
 */
export declare const db: FirebaseFirestore.Firestore;
export declare function assertAllowedCollection(collection: string): void;
