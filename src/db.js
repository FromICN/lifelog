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

/* photo 이미지 항목을 문서 저장용 객체로 정규화 (undefined 필드는 제외) */
const photoObj = (o) => {
  const r = { type: "photo", path: o.path };
  if (o.url) r.url = o.url;
  if (o.thumbPath) r.thumbPath = o.thumbPath;
  if (o.thumbURL) r.thumbURL = o.thumbURL;
  if (o.micro) r.micro = o.micro; // 문서 내장 초소형 미리보기(즉시 표시용)
  return r;
};

/* 새 사진(file 보유)만 업로드하고 문서에 저장할 형태로 변환 */
async function materializeImages(uid, logId, images) {
  const out = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (img.type === "photo" && img.file) {
      const up = await uploadPhoto(uid, logId, `${Date.now()}_${i}`, img.file);
      out.push(photoObj(up)); // { path, url, thumbPath, thumbURL }
    } else if (img.type === "photo") {
      out.push(photoObj(img)); // 기존 사진: url/thumb 필드 보존
    } else {
      out.push({ type: "gradient", value: img.value, label: img.label || "📷" });
    }
  }
  return out;
}

/* 삭제 대상 Storage 경로(원본 + 썸네일) */
const storagePathsOf = (images = []) =>
  images
    .filter((i) => i.type === "photo")
    .flatMap((i) => [i.path, i.thumbPath])
    .filter(Boolean);


/* 생성 */
export async function createLog(uid, data) {
  const ref = doc(logsCol(uid)); // 자동 ID 선발급 → 사진 경로에 사용
  const images = await materializeImages(uid, ref.id, data.images || []);
  await setDoc(ref, {
    date: data.date,
    mood: data.mood || null,
    location: data.location || "",
    text: data.text || "",
    gratitude: data.gratitude || "",
    regret: data.regret || "",
    body: data.body || "",
    mind: data.mind || "",
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
  const keep = new Set(storagePathsOf(images));
  await Promise.all(storagePathsOf(prevImages).filter((p) => !keep.has(p)).map(deletePhoto));
  await updateDoc(doc(db, "users", uid, "logs", id), {
    date: data.date,
    mood: data.mood || null,
    location: data.location || "",
    text: data.text || "",
    gratitude: data.gratitude || "",
    regret: data.regret || "",
    body: data.body || "",
    mind: data.mind || "",
    scrapped: !!data.scrapped,
    images,
    updatedAt: serverTimestamp(),
  });
}

/* 삭제 (사진도 함께 삭제) */
export async function deleteLog(uid, log) {
  await Promise.all(storagePathsOf(log.images).map(deletePhoto));
  await deleteDoc(doc(db, "users", uid, "logs", log.id));
}

/* 스크랩 토글 */
export function setScrap(uid, logId, scrapped) {
  return updateDoc(doc(db, "users", uid, "logs", logId), {
    scrapped,
    updatedAt: serverTimestamp(),
  });
}
