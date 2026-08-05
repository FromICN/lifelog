/* ================================================================
   로컬 일기 스냅샷 (localsnap.js)

   왜 필요한가 — 성능 진단이 알려 준 것
   ─────────────────────────────────────────────────────────────
   실측 타임라인(데스크톱 크롬):

        800ms  JS 번들 실행 시작
        855ms  React 마운트
        862ms  썸네일 캐시 로드 완료   ← 썸네일은 이미 준비됨
       1910ms  인증 확인 완료          ← +1048ms, 최대 병목
       1932ms  Firestore 첫 목록 도착  ← 인증 직후 22ms
       1939ms  첫 썸네일 표시          ← 렌더 후 7ms

   썸네일 자체는 7ms입니다. 문제는 **캘린더 격자가 그려지기까지**
   1932ms가 걸린다는 것이고, 그중 1048ms가 인증 대기입니다.
   썸네일은 862ms에 이미 메모리에 있는데, 그림을 걸 벽(일기 목록)이
   1932ms까지 안 생기니 화면에는 "썸네일이 늦다"로 보입니다.

   해결
   ─────────────────────────────────────────────────────────────
   마지막으로 본 일기 목록을 기기에 저장해 두고, 부팅 시 그것으로
   **인증·Firestore를 기다리지 않고** 캘린더를 즉시 그립니다.
   실제 데이터가 도착하면 조용히 교체됩니다(내용이 같으면 무시).

   → 캘린더+썸네일이 ~1930ms가 아니라 ~870ms에 뜹니다.

   안전장치: 스냅샷에 uid를 함께 저장해, 다른 계정이나 로그아웃
   상태에서는 절대 표시하지 않습니다.
   ================================================================ */
const DB_NAME = "lifelog-snapshot";
const STORE = "snap";
const VERSION = 1;
const KEY = "entries";
const MAX_ENTRIES = 2000;

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

/* 부팅 시 1회: 마지막으로 본 목록을 읽는다 (인증과 병렬, 보통 10ms 이내) */
export async function loadSnapshot() {
  try {
    const db = await openDB();
    const rec = await new Promise((res, rej) => {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
    if (!rec || !Array.isArray(rec.list)) return null;
    return rec; // { uid, list, savedAt }
  } catch { return null; }
}

/* Firestore 목록이 올 때마다 저장 (쓰기는 백그라운드, 실패해도 무시) */
let lastSaved = "";
export async function saveSnapshot(uid, list) {
  if (!uid || !Array.isArray(list)) return;
  try {
    const trimmed = list.slice(0, MAX_ENTRIES);
    /* 내용이 같으면 쓰지 않는다(불필요한 디스크 I/O 방지) */
    const sig = `${uid}:${trimmed.length}:${trimmed.map((e) => e.id + (e.updatedAt?.seconds || "")).join(",")}`;
    if (sig === lastSaved) return;
    lastSaved = sig;

    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ uid, list: trimmed, savedAt: Date.now() }, KEY);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } catch { /* 용량 초과 등은 무시 — 다음 접속에 조금 느릴 뿐 */ }
}

/* 로그아웃 시 정리 */
export async function clearSnapshot() {
  lastSaved = "";
  try {
    const db = await openDB();
    db.transaction(STORE, "readwrite").objectStore(STORE).delete(KEY);
  } catch { /* noop */ }
}
