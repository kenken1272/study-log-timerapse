import {
  GoogleAuthProvider,
  getIdToken,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase/client";

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

export function observeFirebaseAuth(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(firebaseAuth, callback);
}

export async function signInWithGoogle(): Promise<User> {
  const credential = await signInWithPopup(firebaseAuth, googleProvider);
  return credential.user;
}

export async function signOutFromGoogle(): Promise<void> {
  await signOut(firebaseAuth);
}

export async function getCurrentFirebaseIdToken(forceRefresh = false): Promise<string | null> {
  const user = firebaseAuth.currentUser;
  return user ? getIdToken(user, forceRefresh) : null;
}
