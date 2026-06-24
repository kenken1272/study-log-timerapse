import {
  getApps,
  initializeApp,
  type FirebaseApp,
  type FirebaseOptions,
} from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

declare global {
  interface Window {
    __FIREBASE_CONFIG__?: FirebaseOptions;
  }
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

const buildTimeFirebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID ?? "",
};

function hasRequiredFirebaseConfig(config: FirebaseOptions): boolean {
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);
}

function getFirebaseConfig(): FirebaseOptions {
  const runtimeConfig =
    typeof window === "undefined" ? undefined : window.__FIREBASE_CONFIG__;
  const config =
    runtimeConfig && hasRequiredFirebaseConfig(runtimeConfig)
      ? runtimeConfig
      : buildTimeFirebaseConfig;

  if (!hasRequiredFirebaseConfig(config)) {
    throw new Error("Firebase Web SDK config is missing.");
  }

  return config;
}

export function getFirebaseClientApp(): FirebaseApp {
  if (app) {
    return app;
  }

  if (getApps().length > 0) {
    app = getApps()[0]!;
  } else {
    app = initializeApp(getFirebaseConfig());
  }

  return app;
}

export function getFirebaseAuth(): Auth {
  if (!auth) {
    auth = getAuth(getFirebaseClientApp());
  }

  return auth;
}

export const firebaseAuth = new Proxy({} as Auth, {
  get(_target, property) {
    const authInstance = getFirebaseAuth();
    const value = Reflect.get(authInstance, property);
    return typeof value === "function" ? value.bind(authInstance) : value;
  },
});
