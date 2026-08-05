/* ================================================================
   로컬 썸네일 캐시 (IndexedDB)  ── v3
   - 캘린더/격자/피드/스크랩에 쓰는 작은 썸네일을 기기 로컬에 영구 저장
   - 한 번 받은 썸네일은 이후 네트워크 없이 디스크에서 즉시 로드
   - 원본(본문) 이미지는 저장하지 않고 클라우드(Storage)에 그대로 둠
   - 키: Storage 썸네일 경로(thumbPath). 값: WebP Blob

   ── v2 → v3 에서 바뀐 점 ─────────────────────────────────────
   1) 부팅 즉시 "전체 워밍"(warmAll)
      v2는 Firestore 문서가 도착해 키 목록을 알아야만 IndexedDB를 읽을 수
      있었습니다. 즉 [Firestore 대기] → [IDB 읽기] 직렬 구간이 생기고,
      250ms 상한을 넘기면 스켈레톤이 먼저 떴습니다.
      v3는 앱 시작과 동시에 저장소 전체를 트랜잭션 1개로 읽어 메모리에
      올립니다. Firestore 왕복과 **병렬**로 끝나므로, 문서가 도착한 시점엔
      썸네일이 이미 메모리에 있어 첫 렌더부터 그려집니다.

   2) 영구 저장소 요청 (navigator.storage.persist)
      이걸 요청하지 않으면 브라우저는 IndexedDB를 "임시(best-effort)"로
      취급합니다. iOS Safari는 7일 미사용 시 삭제하고, 안드로이드/데스크톱
      크롬도 저장 공간이 부족하면 통째로 비웁니다. → 접속할 때마다
      썸네일을 다시 받는 현상의 가장 흔한 원인입니다.
      v3는 부팅 시 1회 영구 저장소를 요청해 캐시가 살아남게 합니다.

   3) 백그라운드 선다운로드 (prefetchThumbs)
      화면에 아직 안 뜬 썸네일까지 유휴 시간에 미리 받아 두어, 스크랩·지난
      달 캘린더로 이동할 때 네트워크를 타지 않습니다.

   4) 캐시 상태 조회 (cacheStats) — 설정에서 실제 저장 여부를 확인
   ================================================================ */
import { count, setInfo } from "./perf";

const DB_NAME = "lifelog-thumbs";
const STORE = "thumbs";
const VERSION = 1;

/* 메모리에 올려 둘 최대 개수(Blob은 디스크 백업이라 실제 RAM 부담은 작다) */
const WARM_MAX = 3000;

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

/* 저장소 전체를 트랜잭션 1개로 읽기 (키 목록을 몰라도 됨) */
async function idbGetAll() {
  const out = new Map();
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const rk = store.getAllKeys(undefined, WARM_MAX);
      const rv = store.getAll(undefined, WARM_MAX);
      tx.oncomplete = () => {
        const keys = rk.result || [];
        const vals = rv.result || [];
        for (let i = 0; i < keys.length; i++) if (vals[i]) out.set(keys[i], vals[i]);
        res();
      };
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } catch { /* 미지원/오류 시 빈 결과 */ }
  return out;
}

let writeFailures = 0;

/* 쓰기 — 성공 여부를 돌려준다(용량 초과·프라이빗 모드 진단용) */
async function idbPut(key, blob) {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
    count("IDB 저장 성공");
    return true;
  } catch (e) {
    writeFailures++;
    count("IDB 저장 실패");
    setInfo("IDB 저장 실패 원인", e?.name || String(e));
    if (writeFailures <= 3) console.warn("썸네일 로컬 저장 실패:", e?.name || e);
    return false;
  }
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

/* ---------- fetch 차단 감지 ----------
   버킷에 CORS 설정이 없으면 브라우저가 이미지 바이트를 받는 cors fetch를
   전부 거부합니다(TypeError: Failed to fetch). 이 상태에서 계속 재시도하면
   매 접속마다 수십 초를 헛되이 쓰므로, 감지되면 그 세션에서는 중단합니다. */
let fetchBlocked = false;
export const isFetchBlocked = () => fetchBlocked;
const noteFetchError = (e) => {
  if (e instanceof TypeError) fetchBlocked = true;
};

/* ---------- 영구 저장소 (캐시가 지워지지 않게) ---------- */
let persisted = null; // true | false | null(미확인)

export async function ensurePersistentStorage() {
  try {
    if (!navigator?.storage?.persist) { persisted = false; return false; }
    if (await navigator.storage.persisted()) { persisted = true; return true; }
    persisted = await navigator.storage.persist();
    return persisted;
  } catch { persisted = false; return false; }
}

/* ---------- 부팅 워밍 ---------- */
let warmPromise = Promise.resolve();
let allWarmed = false;
let allWarmPromise = null;

/* 앱 시작 시 1회: 저장소 전체를 메모리로. Firestore 왕복과 병렬로 진행된다. */
export function warmAll() {
  if (allWarmPromise) return allWarmPromise;
  allWarmPromise = idbGetAll()
    .then((found) => {
      for (const [k, v] of found) if (!blobs.has(k)) blobs.set(k, v);
      allWarmed = true;
      return found.size;
    })
    .catch(() => { allWarmed = true; return 0; });
  warmPromise = warmPromise.then(() => allWarmPromise).catch(() => {});
  return allWarmPromise;
}

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

/* 특정 키들만 워밍(전체 워밍이 이미 끝났으면 IDB를 다시 읽지 않는다) */
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

  /* 전체 워밍이 끝난 뒤라면 메모리에 없다 = 로컬에도 없다 → 바로 miss 처리 */
  if (allWarmed) {
    for (const k of want) misses.add(k);
    return warmPromise;
  }

  warmPromise = warmPromise
    .then(() => allWarmPromise || null)
    .then(() => {
      const rest = want.filter((k) => !blobs.has(k));
      return rest.length ? idbGetMany(rest) : new Map();
    })
    .then((found) => {
      for (const k of want) {
        if (blobs.has(k)) continue;
        const blob = found.get(k);
        if (blob) blobs.set(k, blob);
        else misses.add(k); // 로컬에 없음 → 개별 요청 때 네트워크로
      }
    })
    .catch(() => {});
  return warmPromise;
}

/* 로컬(메모리 → 워밍 대기 → IDB) → 없으면 fetchBlob()로 받아 캐시 → objectURL */
export async function loadThumb(key, fetchBlob) {
  if (!key) return null;

  const mem = peekThumbUrl(key);
  if (mem) return mem;

  // 진행 중인 워밍이 있으면 그 결과를 먼저 활용 (개별 IDB 조회 회피)
  if (!misses.has(key)) {
    await warmPromise;
    const warmed = peekThumbUrl(key);
    if (warmed) return warmed;
  }

  let blob = misses.has(key) || allWarmed ? null : await idbGet(key);
  if (!blob && typeof fetchBlob === "function" && !fetchBlocked) {
    try {
      blob = await fetchBlob();
      if (blob) idbPut(key, blob);
    } catch (e) { noteFetchError(e); blob = null; }
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

/* ---------- 백그라운드 선다운로드 ----------
   화면에 아직 안 뜬 썸네일까지 유휴 시간에 미리 받아 IndexedDB에 저장한다.
   items: [{ key, url }]  (url이 없으면 resolveURL(key)로 얻는다)
   동시 요청은 4개로 제한해 초기 렌더를 방해하지 않는다. */
let prefetching = false;

export async function prefetchThumbs(items, resolveURL, onProgress) {
  if (prefetching) return 0;
  prefetching = true;
  try {
    await warmAll();
    const todo = [];
    const seen = new Set();
    for (const it of items || []) {
      const key = it?.key;
      if (!key || seen.has(key) || blobs.has(key)) continue;
      seen.add(key);
      todo.push(it);
    }
    if (!todo.length) { onProgress?.(0, 0); return 0; }

    if (fetchBlocked) { count("선다운로드 중단(fetch 차단)"); return 0; }

    let done = 0;
    let ok = 0;
    let i = 0;
    const CONCURRENCY = 4;

    const worker = async () => {
      while (i < todo.length) {
        if (fetchBlocked) return; // 차단 확인되면 나머지는 시도하지 않는다
        const it = todo[i++];
        try {
          const url = it.url || (resolveURL ? await resolveURL(it.key) : null);
          if (!url) { count("선다운로드 실패(URL 없음)"); }
          else {
            const res = await fetch(url);
            if (!res.ok) {
              count("선다운로드 실패(HTTP)");
              setInfo("선다운로드 HTTP 상태", res.status);
            } else {
              const blob = await res.blob();
              if (blob && blob.size) {
                blobs.set(it.key, blob);
                misses.delete(it.key);
                if (await idbPut(it.key, blob)) ok++;
              } else count("선다운로드 실패(빈 응답)");
            }
          }
        } catch (e) {
          noteFetchError(e);
          count("선다운로드 실패(예외)");
          setInfo("선다운로드 예외", e?.name || String(e));
        }
        onProgress?.(++done, todo.length);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker)
    );
    return ok;
  } finally {
    prefetching = false;
  }
}

/* ---------- 상태 조회 (설정 화면 진단용) ---------- */
export async function cacheStats() {
  let count = 0;
  let bytes = 0;
  try {
    const db = await openDB();
    const vals = await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readonly");
      const r = tx.objectStore(STORE).getAll();
      tx.oncomplete = () => res(r.result || []);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
    count = vals.length;
    for (const v of vals) bytes += v?.size || 0;
  } catch { /* 미지원 */ }

  let quota = null;
  let usage = null;
  try {
    if (navigator?.storage?.estimate) {
      const est = await navigator.storage.estimate();
      quota = est.quota ?? null;
      usage = est.usage ?? null;
    }
  } catch { /* noop */ }

  let isPersisted = persisted;
  try {
    if (navigator?.storage?.persisted) isPersisted = await navigator.storage.persisted();
  } catch { /* noop */ }

  return { count, bytes, quota, usage, persisted: isPersisted, writeFailures };
}

/* 캐시 비우기 (문제 발생 시 초기화용) */
export async function clearThumbCache() {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch { /* noop */ }
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
  blobs.clear();
  misses.clear();
  allWarmed = false;
  allWarmPromise = null;
  writeFailures = 0;
}
