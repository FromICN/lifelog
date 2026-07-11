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
import { getStorage } from "firebase/storage";
import { Capacitor } from "@capacitor/core";
import { firebaseConfig } from "./firebase-config";

/* firebase-config.js에 실제 값이 입력됐는지 여부 (미입력 시 안내 화면 표시) */
export const CONFIG_READY = !String(firebaseConfig.apiKey).startsWith("YOUR_");

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

export const storage = getStorage(app);

export const isNative = Capacitor.isNativePlatform();

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
