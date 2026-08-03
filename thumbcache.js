/* ================================================================
   로컬 썸네일 캐시 (IndexedDB)
   - 캘린더/격자/스크랩 등에 쓰는 작은 썸네일 이미지를 기기 로컬에 저장
   - 한 번 보거나 업로드한 썸네일은 이후 네트워크 없이 디스크에서 즉시 로드
   - 원본(본문) 이미지는 여기 저장하지 않고 클라우드(Storage)에 그대로 둠
   - 키: Storage 썸네일 경로(thumbPath). 값: WebP Blob
   ================================================================ */
const DB_NAME = "lifelog-thumbs";
const STORE = "thumbs";
const VERSION = 1;

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB 미지원"));
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet(key) {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
  } catch { return null; }
}

async function idbPut(key, blob) {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch { /* 용량 초과/미지원 등은 무시 */ }
}

async function idbDelete(key) {
  try {
    const db = await openDB();
    db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
  } catch { /* noop */ }
}

/* 세션 내 objectURL 재사용(같은 썸네일 재요청 시 즉시 반환) */
const objectUrls = new Map(); // key → objectURL

/* 이미 메모리에 잡힌 objectURL이 있으면 동기 반환(스켈레톤 없이 바로 표시) */
export function peekThumbUrl(key) {
  return (key && objectUrls.get(key)) || null;
}

/* 로컬(IDB) → 없으면 fetchBlob()로 받아 캐시 → objectURL 반환 */
export async function loadThumb(key, fetchBlob) {
  if (!key) return null;
  const mem = objectUrls.get(key);
  if (mem) return mem;

  let blob = await idbGet(key);
  if (!blob && typeof fetchBlob === "function") {
    try {
      blob = await fetchBlob();
      if (blob) idbPut(key, blob);
    } catch { blob = null; }
  }
  if (!blob) return null;

  const url = URL.createObjectURL(blob);
  objectUrls.set(key, url);
  return url;
}

/* 업로드/백필 시 이미 만든 썸네일 Blob을 로컬에 심어 둠 */
export function putThumb(key, blob) {
  if (!key || !blob) return;
  idbPut(key, blob);
}

/* 삭제 시 로컬 캐시도 정리 */
export function dropThumb(key) {
  if (!key) return;
  idbDelete(key);
  const url = objectUrls.get(key);
  if (url) { URL.revokeObjectURL(url); objectUrls.delete(key); }
}
