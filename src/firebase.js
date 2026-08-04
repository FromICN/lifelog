/* ================================================================
   Firebase 초기화 + 인증
   - 웹: signInWithPopup
   - APK(Capacitor 네이티브): @capacitor-firebase/authentication으로
     네이티브 Google 로그인 → idToken을 웹 SDK signInWithCredential에
     연결. 이후 Firestore/Storage는 양쪽 모두 웹 SDK 하나로 동작.
   - Firestore 오프라인 persistence(IndexedDB) 활성화.
   ================================================================ */
import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
  signOut as firebaseSignOut,
} from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { firebaseConfig } from "./firebase-config";

/* firebase-config.js에 실제 값이 입력됐는지 여부 (미입력 시 안내 화면 표시) */
export const CONFIG_READY = !String(firebaseConfig.apiKey).startsWith("YOUR_");

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

/* Storage는 첫 화면에 필요 없다 (사진 URL은 Firestore 문서에, 썸네일은
   IndexedDB에 이미 있음). 정적으로 import하면 초기 번들이 ~77KB 커지므로
   실제로 필요한 시점(업로드/삭제/URL 조회)에만 지연 로드한다. */
let storagePromise = null;
export function getStorageLazy() {
  if (!storagePromise) {
    storagePromise = import("firebase/storage").then((m) => ({
      ...m,
      storage: m.getStorage(app),
    }));
  }
  return storagePromise;
}

/* @capacitor/core(21KB)를 초기 번들에 넣지 않기 위한 동등 판정.
   Capacitor 네이티브 런타임은 번들 로드 전에 window.Capacitor를 주입한다. */
export const isNative =
  typeof window !== "undefined" &&
  !!window.Capacitor &&
  (typeof window.Capacitor.isNativePlatform === "function"
    ? window.Capacitor.isNativePlatform()
    : window.Capacitor.platform !== undefined && window.Capacitor.platform !== "web");

/* Google 로그인 (플랫폼 분기) */
export async function signInWithGoogle() {
  if (isNative) {
    const { FirebaseAuthentication } = await import("@capacitor-firebase/authentication");
    const result = await FirebaseAuthentication.signInWithGoogle();
    const idToken = result.credential?.idToken;
    if (!idToken) throw new Error("Google 로그인에 실패했습니다");
    const credential = GoogleAuthProvider.credential(idToken);
    return (await signInWithCredential(auth, credential)).user;
  }
  const provider = new GoogleAuthProvider();
  return (await signInWithPopup(auth, provider)).user;
}

/* 로그아웃 (네이티브 세션도 함께 정리) */
export async function logOut() {
  if (isNative) {
    try {
      const { FirebaseAuthentication } = await import("@capacitor-firebase/authentication");
      await FirebaseAuthentication.signOut();
    } catch {
      /* 네이티브 로그아웃 실패는 무시 */
    }
  }
  await firebaseSignOut(auth);
}
