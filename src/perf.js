/* ================================================================
   부팅·썸네일 성능 계측  (perf.js)

   왜 필요한가
   ─────────────────────────────────────────────────────────────
   "썸네일이 느리다"는 증상 하나에 원인 후보가 여럿입니다.

     A. 번들 다운로드·파싱이 느림        (JS 830KB / gzip 190KB)
     B. Firestore 로컬 캐시 열기가 느림  (IndexedDB 초기화)
     C. 인증 확인 대기
     D. 문서 목록이 서버에서 오고 있음   (로컬 캐시 미적중)
     E. 썸네일 자체가 네트워크에서 옴    (썸네일 캐시 미적중)

   A~D는 **썸네일과 무관한 구간**입니다. 그런데 캘린더 격자는 문서가
   도착해야 그려지므로, A~D가 느리면 썸네일 캐시가 완벽해도 사용자
   눈에는 "썸네일이 늦게 뜬다"로 보입니다. 추측으로 E만 고쳐서는
   체감이 바뀌지 않습니다.

   이 모듈은 각 구간에 실제 시간을 찍어, 어느 구간이 범인인지
   숫자로 특정합니다. 설정 → 성능 진단에서 확인할 수 있고,
   콘솔에서는 window.__perf() 로도 볼 수 있습니다.

   오버헤드: performance.now() 호출 몇 번 (사실상 0)
   ================================================================ */

const t0 =
  typeof performance !== "undefined" && performance.timeOrigin != null
    ? 0
    : 0;

const marks = [];       // { name, t }  t = 페이지 시작 후 경과 ms
const counters = new Map();
const seenMarks = new Set();

const now = () =>
  typeof performance !== "undefined" ? Math.round(performance.now() - t0) : 0;

/* 구간 도달 시각 기록 (같은 이름은 처음 한 번만) */
export function mark(name) {
  if (seenMarks.has(name)) return;
  seenMarks.add(name);
  marks.push({ name, t: now() });
}

/* 횟수 누적 (캐시 적중/미적중 등) */
export function count(name, n = 1) {
  counters.set(name, (counters.get(name) || 0) + n);
}

export function setInfo(name, value) {
  counters.set(name, value);
}

/* ---------- Storage 네트워크 사용량 (실측) ----------
   썸네일이 정말 네트워크에서 오는지, 온다면 몇 개·몇 바이트인지를
   브라우저의 리소스 타이밍에서 직접 읽는다. 서비스워커/HTTP 캐시에서
   나온 응답은 transferSize가 0에 가까우므로 구분이 된다. */
let observing = false;
export function observeNetwork() {
  if (observing || typeof PerformanceObserver === "undefined") return;
  observing = true;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.name || !e.name.includes("firebasestorage")) continue;
        count("storage:요청수");
        count("storage:전송바이트", Math.round(e.transferSize || 0));
        count("storage:총시간ms", Math.round(e.duration || 0));
      }
    });
    obs.observe({ type: "resource", buffered: true });
  } catch { /* 미지원 브라우저는 조용히 건너뜀 */ }
}

/* ---------- 결과 ---------- */
export function report() {
  const sorted = [...marks].sort((a, b) => a.t - b.t);
  const timeline = sorted.map((m, i) => ({
    구간: m.name,
    누적ms: m.t,
    직전대비ms: i === 0 ? m.t : m.t - sorted[i - 1].t,
  }));
  return { timeline, counters: Object.fromEntries(counters) };
}

/* 나에게 붙여넣기 좋은 한 덩어리 텍스트 */
export function reportText() {
  const { timeline, counters: c } = report();
  const lines = ["[LifeLog 성능 진단]"];
  lines.push(`UA: ${typeof navigator !== "undefined" ? navigator.userAgent : "?"}`);
  lines.push("--- 타임라인 (페이지 시작 기준) ---");
  for (const r of timeline) {
    lines.push(`${String(r.누적ms).padStart(6)}ms  (+${String(r.직전대비ms).padStart(5)})  ${r.구간}`);
  }
  lines.push("--- 카운터 ---");
  for (const [k, v] of Object.entries(c)) lines.push(`${k}: ${v}`);
  return lines.join("\n");
}

if (typeof window !== "undefined") {
  window.__perf = () => {
    const r = report();
    console.table(r.timeline);
    console.table(r.counters);
    return r;
  };
}
