/* ================================================================
   사진 처리
   - 업로드 전 클라이언트 압축: 긴 변 1600px 리사이즈 + WebP 변환
     (품질을 단계적으로 낮춰 200~400KB 목표)
   - Firebase Storage 경로: users/{uid}/photos/{logId}_{n}.webp
   - Firestore 문서에는 Storage 경로(path)만 저장
   ================================================================ */
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { storage } from "./firebase";

const LONG_EDGE = 1600;
const TARGET_MAX_BYTES = 400 * 1024; // 400KB
const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];

const canvasToBlob = (canvas, type, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/* File/Blob → 리사이즈 + WebP 압축된 Blob */
export async function compressImage(fileOrBlob) {
  const bitmap = await createImageBitmap(fileOrBlob, { imageOrientation: "from-image" });
  const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  let last = null;
  for (const q of QUALITY_STEPS) {
    const blob = await canvasToBlob(canvas, "image/webp", q);
    if (!blob) break;
    last = blob;
    if (blob.size <= TARGET_MAX_BYTES) return blob;
  }
  if (!last) throw new Error("이미지 변환에 실패했습니다");
  return last; // 최저 품질로도 400KB 초과 시 그대로 사용
}

/* 압축 후 업로드 → Storage 경로 반환 */
export async function uploadPhoto(uid, logId, index, fileOrBlob) {
  const blob = await compressImage(fileOrBlob);
  const path = `users/${uid}/photos/${logId}_${index}.webp`;
  await uploadBytes(ref(storage, path), blob, { contentType: "image/webp" });
  return path;
}

/* 경로 → 다운로드 URL (메모리 캐시) */
const urlCache = new Map();
export function getPhotoURL(path) {
  if (!urlCache.has(path)) {
    urlCache.set(
      path,
      getDownloadURL(ref(storage, path)).catch((e) => {
        urlCache.delete(path); // 실패 시 재시도 가능하게
        throw e;
      })
    );
  }
  return urlCache.get(path);
}

/* 삭제 (없는 파일 등 오류는 무시) */
export function deletePhoto(path) {
  return deleteObject(ref(storage, path)).catch(() => {});
}
