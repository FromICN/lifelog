/* ================================================================
   로컬 썸네일 캐시 (IndexedDB)
   - 캘린더/격자/피드/스크랩에 쓰는 작은 썸네일 이미지를 기기 로컬에 저장
   - 한 번 보거나 업로드한 썸네일은 이후 네트워크 없이 디스크에서 즉시 로드
   - 원본(본문) 이미지는 여기 저장하지 않고 클라우드(Storage)에 그대로 둠
   - 키: Storage 썸네일 경로(thumbPath). 값: WebP Blob

   ── v2 최적화 ───────────────────────────────────────────────
   기존에는 <img> 하나가 마운트될 때마다 IndexedDB 트랜잭션을 하나씩
   열었습니다. 캘린더/격자에 썸네일이 60~200장이면 트랜잭션도 그만큼
   생기고, 각각이 마이크로태스크 큐를 타면서 사진이 뒤늦게 채워졌습니다.

   warmThumbs(keys)로 **트랜잭션 하나에서 전부 읽어** 메모리에 올려 둡니다.
   그 뒤 peekThumbUrl(key)는 동기로 즉시 URL을 돌려주므로
   첫 렌더부터 스켈레톤 없이 사진이 그려집니다.

   메모리 관리: Blob 자체는 대부분 디스크 백업이라 부담이 적고,
   objectURL은 실제로 화면에 필요할 때(peek 시점) 지연 생성합니다.
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

/* 여러 키를 트랜잭션 1개로 한 번에 읽기 */
async function idbGetMany(keys) {
  const out = new Map();
  if (!keys.length) return out;
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      for (const k of keys) {
        const r = store.get(k);
        r.onsuccess = () => { if (r.result) out.set(k, r.result); };
      }
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } catch { /* 미지원/오류 시 빈 결과 */ }
  return out;
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

/* ---------- 메모리 레이어 ---------- */
const blobs = new Map();      // key → Blob        (warm 결과)
const objectUrls = new Map(); // key → objectURL   (실제 표시된 것만)
const misses = new Set();     // 로컬에 없다고 확인된 키 (중복 조회 방지)

let warmPromise = Promise.resolve();

/* 이미 로컬에 있는 썸네일이면 동기로 URL 반환(스켈레톤 없이 바로 표시) */
export function peekThumbUrl(key) {
  if (!key) return null;
  const url = objectUrls.get(key);
  if (url) return url;
  const blob = blobs.get(key);
  if (!blob) return null;
  const made = URL.createObjectURL(blob);
  objectUrls.set(key, made);
  return made;
}

/* 화면에 뿌릴 썸네일들을 트랜잭션 1개로 미리 메모리에 올림.
   awaitable — 첫 렌더 전에 짧게 기다리면 사진이 깜빡임 없이 나타납니다. */
export function warmThumbs(keys) {
  const want = [];
  const seen = new Set();
  for (const k of keys) {
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (blobs.has(k) || objectUrls.has(k) || misses.has(k)) continue;
    want.push(k);
  }
  if (!want.length) return warmPromise;

  warmPromise = warmPromise
    .then(() => idbGetMany(want))
    .then((found) => {
      for (const k of want) {
        const blob = found.get(k);
        if (blob) blobs.set(k, blob);
        else misses.add(k); // 로컬에 없음 → 개별 요청 때 네트워크로
      }
    })
    .catch(() => {});
  return warmPromise;
}

/* 로컬(메모리 → warm 대기 → IDB) → 없으면 fetchBlob()로 받아 캐시 → objectURL */
export async function loadThumb(key, fetchBlob) {
  if (!key) return null;

  const mem = peekThumbUrl(key);
  if (mem) return mem;

  // 진행 중인 일괄 워밍이 있으면 그 결과를 먼저 활용 (개별 IDB 조회 회피)
  if (!misses.has(key)) {
    await warmPromise;
    const warmed = peekThumbUrl(key);
    if (warmed) return warmed;
  }

  let blob = misses.has(key) ? null : await idbGet(key);
  if (!blob && typeof fetchBlob === "function") {
    try {
      blob = await fetchBlob();
      if (blob) idbPut(key, blob);
    } catch { blob = null; }
  }
  if (!blob) { misses.add(key); return null; }

  misses.delete(key);
  blobs.set(key, blob);
  return peekThumbUrl(key);
}

/* 업로드/백필 시 이미 만든 썸네일 Blob을 로컬에 심어 둠 */
export function putThumb(key, blob) {
  if (!key || !blob) return;
  blobs.set(key, blob);
  misses.delete(key);
  idbPut(key, blob);
}

/* 삭제 시 로컬 캐시도 정리 */
export function dropThumb(key) {
  if (!key) return;
  idbDelete(key);
  blobs.delete(key);
  misses.delete(key);
  const url = objectUrls.get(key);
  if (url) { URL.revokeObjectURL(url); objectUrls.delete(key); }
}
