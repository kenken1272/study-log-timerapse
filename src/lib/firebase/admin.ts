import { Firestore } from "@google-cloud/firestore";

let firestore: Firestore | null = null;

export function getFirestoreDb(): Firestore {
  if (!firestore) {
    firestore = new Firestore({
      projectId: process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT,
    });
  }

  return firestore;
}
