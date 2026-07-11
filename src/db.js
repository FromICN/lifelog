/* ================================================================
   Firestore 데이터 계층
   - 구조: users/{uid}/logs/{logId}
   - 문서 필드: date, mood, location, text, scrapped, images[],
     createdAt, updatedAt
   - images 항목:
     { type: "gradient", value, label }  → 문서에 그대로 저장
     { type: "photo", path }             → Storage 경로만 저장
     (저장 전 임시 상태 { type: "photo", file, preview }는
      materializeImages()에서 압축·업로드 후 path로 치환)
   ================================================================ */
import {
  collection,
  doc,
  query,
  orderBy,
  onSnapshot,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "./firebase";
import { uploadPhoto, deletePhoto } from "./photos";

const logsCol = (uid) => collection(db, "users", uid, "logs");

/* 실시간 구독: onSnapshot (오프라인 캐시 포함) → unsubscribe 반환 */
export function subscribeLogs(uid, onData, onError) {
  const q = query(logsCol(uid), orderBy("date", "desc"));
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

/* 새 사진(file 보유)만 업로드하고 문서에 저장할 형태로 변환 */
async function materializeImages(uid, logId, images) {
  const out = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (img.type === "photo" && img.file) {
      const path = await uploadPhoto(uid, logId, `${Date.now()}_${i}`, img.file);
      out.push({ type: "photo", path });
    } else if (img.type === "photo") {
      out.push({ type: "photo", path: img.path });
    } else {
      out.push({ type: "gradient", value: img.value, label: img.label || "📷" });
    }
  }
  return out;
}

const photoPaths = (images = []) =>
  images.filter((i) => i.type === "photo" && i.path).map((i) => i.path);

/* 생성 */
export async function createLog(uid, data) {
  const ref = doc(logsCol(uid)); // 자동 ID 선발급 → 사진 경로에 사용
  const images = await materializeImages(uid, ref.id, data.images || []);
  await setDoc(ref, {
    date: data.date,
    mood: data.mood || null,
    location: data.location || "",
    text: data.text || "",
    scrapped: !!data.scrapped,
    images,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

/* 수정 (편집에서 제거된 사진은 Storage에서도 삭제) */
export async function updateLog(uid, prevImages, log) {
  const { id, createdAt, ...data } = log;
  const images = await materializeImages(uid, id, data.images || []);
  const keep = new Set(photoPaths(images));
  await Promise.all(photoPaths(prevImages).filter((p) => !keep.has(p)).map(deletePhoto));
  await updateDoc(doc(db, "users", uid, "logs", id), {
    date: data.date,
    mood: data.mood || null,
    location: data.location || "",
    text: data.text || "",
    scrapped: !!data.scrapped,
    images,
    updatedAt: serverTimestamp(),
  });
}

/* 삭제 (사진도 함께 삭제) */
export async function deleteLog(uid, log) {
  await Promise.all(photoPaths(log.images).map(deletePhoto));
  await deleteDoc(doc(db, "users", uid, "logs", log.id));
}

/* 스크랩 토글 */
export function setScrap(uid, logId, scrapped) {
  return updateDoc(doc(db, "users", uid, "logs", logId), {
    scrapped,
    updatedAt: serverTimestamp(),
  });
}
