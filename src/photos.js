/* ================================================================
   사진 처리
   - 업로드 전 클라이언트 압축(WebP):
       원본:  긴 변 1600px, 목표 ≤400KB
       썸네일: 긴 변 400px, 목표 ≤40KB   (캘린더/격자/스크랩용)
   - Storage 경로:
       users/{uid}/photos/{logId}_{n}.webp
       users/{uid}/photos/{logId}_{n}_thumb.webp
   - Firestore 이미지 항목에는 path/thumbPath와 함께
     다운로드 URL(url/thumbURL)도 저장 → 접속 시 getDownloadURL 왕복 제거
   - path→URL 매핑은 localStorage에도 캐시(세션 간 유지)
   ================================================================ */
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { storage } from "./firebase";
import { putThumb, dropThumb } from "./thumbcache";

const FULL_EDGE = 1600;
const FULL_MAX = 400 * 1024;
const FULL_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];

const THUMB_EDGE = 400;
const THUMB_MAX = 40 * 1024;
const THUMB_STEPS = [0.7, 0.6, 0.5, 0.4];

const canvasToBlob = (canvas, type, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/* File/Blob → 리사이즈 + WebP 압축 */
async function resizeToWebp(fileOrBlob, longEdge, targetMax, qualitySteps) {
  const bitmap = await createImageBitmap(fileOrBlob, { imageOrientation: "from-image" });
  const scale = Math.min(1, longEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  let last = null;
  for (const q of qualitySteps) {
    const blob = await canvasToBlob(canvas, "image/webp", q);
    if (!blob) break;
    last = blob;
    if (blob.size <= targetMax) return blob;
  }
  if (!last) throw new Error("이미지 변환에 실패했습니다");
  return last; // 최저 품질로도 목표 초과 시 그대로 사용
}

export const compressImage = (f) => resizeToWebp(f, FULL_EDGE, FULL_MAX, FULL_STEPS);
export const compressThumb = (f) => resizeToWebp(f, THUMB_EDGE, THUMB_MAX, THUMB_STEPS);

/* 원본 경로 → 썸네일 경로 (.webp 앞에 _thumb 삽입) */
export const thumbPathFor = (path) =>
  /\.[a-z0-9]+$/i.test(path) ? path.replace(/(\.[a-z0-9]+)$/i, "_thumb$1") : `${path}_thumb.webp`;

/* ---------- path → URL 캐시 (메모리 + localStorage) ---------- */
const LS_KEY = "lifelog-url-cache";
const urlCache = new Map(); // path → Promise<url>
let lsCache = null;

function ls() {
  if (lsCache) return lsCache;
  try { lsCache = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); }
  catch { lsCache = {}; }
  return lsCache;
}
function lsSet(path, url) {
  try {
    const c = ls();
    c[path] = url;
    localStorage.setItem(LS_KEY, JSON.stringify(c));
  } catch { /* 용량 초과 등은 무시 */ }
}
function lsDel(path) {
  try {
    const c = ls();
    if (path in c) { delete c[path]; localStorage.setItem(LS_KEY, JSON.stringify(c)); }
  } catch { /* noop */ }
}

/* 업로드 시 알게 된 URL을 캐시에 심어 둠 */
export function primePhotoURL(path, url) {
  if (!path || !url) return;
  urlCache.set(path, Promise.resolve(url));
  lsSet(path, url);
}

/* 경로 → 다운로드 URL (메모리 → localStorage → 네트워크 순) */
export function getPhotoURL(path) {
  if (urlCache.has(path)) return urlCache.get(path);
  const cached = ls()[path];
  if (cached) {
    const p = Promise.resolve(cached);
    urlCache.set(path, p);
    return p;
  }
  const p = getDownloadURL(ref(storage, path))
    .then((u) => { lsSet(path, u); return u; })
    .catch((e) => { urlCache.delete(path); throw e; });
  urlCache.set(path, p);
  return p;
}

/* 캐시된 URL이 만료/무효일 때 무효화 (다음 요청은 네트워크 재조회) */
export function invalidatePhotoURL(path) {
  urlCache.delete(path);
  lsDel(path);
}

/* 압축(원본+썸네일) 후 업로드 → { path, url, thumbPath, thumbURL } */
export async function uploadPhoto(uid, logId, index, fileOrBlob) {
  const [fullBlob, thumbBlob] = await Promise.all([
    compressImage(fileOrBlob),
    compressThumb(fileOrBlob),
  ]);
  const path = `users/${uid}/photos/${logId}_${index}.webp`;
  const thumbPath = thumbPathFor(path);
  const fullRef = ref(storage, path);
  const thumbRef = ref(storage, thumbPath);

  await Promise.all([
    uploadBytes(fullRef, fullBlob, { contentType: "image/webp" }),
    uploadBytes(thumbRef, thumbBlob, { contentType: "image/webp" }),
  ]);
  const [url, thumbURL] = await Promise.all([
    getDownloadURL(fullRef),
    getDownloadURL(thumbRef),
  ]);
  primePhotoURL(path, url);
  primePhotoURL(thumbPath, thumbURL);
  putThumb(thumbPath, thumbBlob); // 로컬 캐시에 즉시 저장 → 이 기기에서 바로 표시
  return { path, url, thumbPath, thumbURL };
}

/* 삭제 (없는 파일 등 오류는 무시) */
export function deletePhoto(path) {
  invalidatePhotoURL(path);
  dropThumb(path); // 썸네일 경로면 로컬 캐시도 정리
  return deleteObject(ref(storage, path)).catch(() => {});
}
