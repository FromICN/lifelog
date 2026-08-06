/* ================================================================
   LifeLog PWA 서비스워커  (v2 — 콜드 스타트 최적화)

   v1 대비 바뀐 점
   1) 페이지 내비게이션: network-first → **cache-first + 백그라운드 갱신**
      앱을 켤 때마다 index.html 네트워크 왕복(모바일 200~600ms)을 기다리던
      구간이 사라집니다. 캐시된 셸을 즉시 그려 주고, 새 버전은 조용히
      받아 두었다가 다음 실행에 반영됩니다.
   2) 사진 캐시를 셸 캐시와 분리
      v1은 CACHE 상수를 올리면 캐시된 Firebase Storage 사진까지 전부
      삭제돼서, 앱을 업데이트할 때마다 사진을 다시 받아야 했습니다.
      이제 사진은 별도 캐시(lifelog-photos)에 있어 배포와 무관하게 유지됩니다.
   3) 해시가 붙은 정적 자산(assets/*)은 내용 불변 → 완전 cache-first
      (파일명이 바뀌면 새 파일이므로 재검증 자체가 불필요)
   4) 사진 캐시 용량 상한(오래된 항목부터 정리) 추가

   셸을 강제로 새로 받게 하려면 SHELL_VERSION만 올리면 됩니다.
   ================================================================ */

const SHELL_VERSION = "v5";
const SHELL_CACHE = `lifelog-shell-${SHELL_VERSION}`;
const ASSET_CACHE = `lifelog-assets-${SHELL_VERSION}`;
/* ── 사진 캐시를 서비스워커에서 제거한 이유 (v4) ──────────────
   진단에서 Storage로 나가는 fetch()가 100% "TypeError: Failed to fetch"로
   실패하는데, 같은 URL을 <img>로 부르면 정상 표시되는 현상이 나왔습니다.

   원인: 예전 버전 서비스워커가 <img>의 no-cors 요청에서 돌아온
   **opaque 응답**을 lifelog-photos 캐시에 넣어 두었습니다. 이 캐시는
   "배포 버전과 무관하게 유지"하도록 KEEP에 들어 있어서, 그 뒤 어떤 배포를
   해도 절대 지워지지 않았습니다. cacheFirst는 요청 mode를 보지 않고 캐시된
   응답을 그대로 돌려주므로, mode:'cors'로 나간 fetch()가 opaque 응답을
   받게 되고 브라우저는 이를 TypeError로 거부합니다. <img>(no-cors)는
   opaque를 그대로 받으니 멀쩡히 보이고요.

   → 썸네일이 IndexedDB에 단 1장(10KB)만 쌓여 있던 진짜 이유가 이것입니다.
     캐시 계층을 아무리 고쳐도, blob을 가져오는 fetch 자체가 매번
     실패하고 있었으니 저장될 것이 없었습니다.

   이제 사진 blob 캐시는 앱의 IndexedDB(thumbcache.js)가 전담합니다.
   서비스워커가 중복으로 개입할 이유가 없고, 개입하면 이런 오염이
   재발할 수 있으므로 아예 손대지 않습니다. 원본은 업로드 시 붙인
   `immutable, 1년` 헤더 덕에 브라우저 HTTP 캐시가 처리합니다. */
const POISONED_PHOTO_CACHE = "lifelog-photos"; // v4에서 삭제 대상
const KEEP = [SHELL_CACHE, ASSET_CACHE];

const SCOPE = self.registration.scope; // 예: https://fromicn.github.io/lifelog/
const SHELL_URL = SCOPE + "index.html";
const SHELL = [SCOPE, SHELL_URL, SCOPE + "manifest.webmanifest"];

/* ---------------- install ---------------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        await cache.addAll(SHELL);
      } catch {
        /* 일부 404여도 무시 */
      }
      await self.skipWaiting();
    })()
  );
});

/* ---------------- activate ---------------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      /* opaque 응답으로 오염된 예전 사진 캐시를 확실히 제거한다 */
      await caches.delete(POISONED_PHOTO_CACHE);
      await Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

/* 앱에서 즉시 업데이트를 요청할 때 */
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

/* 새 셸이 도착하면 열려 있는 탭에 알려 준다(페이지가 1회 새로고침).
   이전에는 "다음 실행에 반영"이었는데, 사용자가 배포 직후 확인하면
   예전 버전이 보여 개선이 안 된 것처럼 느껴졌다. */
let lastShellETag = null;
async function notifyIfShellChanged(resp) {
  try {
    const tag = resp.headers.get("etag") || resp.headers.get("last-modified");
    if (!tag) return;
    if (lastShellETag === null) { lastShellETag = tag; return; }
    if (tag === lastShellETag) return;
    lastShellETag = tag;
    const clients = await self.clients.matchAll({ type: "window" });
    for (const c of clients) c.postMessage({ type: "SHELL_UPDATED" });
  } catch { /* noop */ }
}

/* ---------------- 전략 ---------------- */

/* 캐시 우선 + 백그라운드 갱신: 응답은 즉시, 최신화는 조용히 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((resp) => {
      if (resp && resp.status === 200 && (resp.type === "basic" || resp.type === "cors")) {
        cache.put(request, resp.clone());
      }
      return resp;
    })
    .catch(() => null);

  if (cached) return cached; // ← 네트워크를 기다리지 않는다
  return (await network) || Response.error();
}

/* 완전 캐시 우선 (해시 자산·사진처럼 내용이 바뀌지 않는 것) */
async function cacheFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  /* opaque 응답을 cors 요청에 돌려주면 브라우저가 TypeError로 거부한다.
     그런 항목은 무시하고 네트워크로 다시 받는다. */
  const usable = cached && !(cached.type === "opaque" && request.mode === "cors");
  if (usable) return cached;
  try {
    const resp = await fetch(request);
    if (resp && resp.status === 200) {
      cache.put(request, resp.clone()).then(() => limit && trimCache(cacheName, limit));
    }
    return resp;
  } catch {
    return (usable ? cached : null) || Response.error();
  }
}

/* 캐시 항목 수 상한 초과 시 오래된 것부터 정리 */
async function trimCache(cacheName, max) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= max) return;
    // Cache Storage는 삽입 순서를 유지 → 앞쪽이 가장 오래된 항목
    await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
  } catch {
    /* noop */
  }
}

/* ---------------- fetch ---------------- */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  const host = url.hostname;

  /* 1) 페이지 내비게이션 → 캐시된 셸 즉시 반환 + 백그라운드 갱신
        (앱 실행 시 체감 지연의 가장 큰 원인이던 구간) */
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = (await cache.match(SHELL_URL)) || (await cache.match(SCOPE));

        /* 반드시 HTTP 캐시를 우회한다.
           GitHub Pages는 index.html에 `cache-control: max-age=600`을 붙이므로,
           일반 fetch로는 10분간 예전 index.html이 그대로 돌아온다. 그걸 다시
           셸 캐시에 넣으면 예전 자산 해시를 계속 가리키게 되어, 새로 배포해도
           기기에는 영원히 반영되지 않는다(실제로 그렇게 되어 있었다). */
        const network = fetch(request, { cache: "no-store" })
          .then((resp) => {
            if (resp && resp.status === 200) {
              cache.put(SHELL_URL, resp.clone());
              /* 셸이 실제로 바뀌었으면 열려 있는 탭에 알린다 */
              notifyIfShellChanged(resp.clone());
            }
            return resp;
          })
          .catch(() => null);

        if (cached) {
          // 갱신은 응답을 돌려준 뒤에도 계속 진행시킨다.
          // (이벤트가 이미 비활성이면 waitUntil이 던질 수 있어 방어)
          try { event.waitUntil(network); } catch { /* 그대로 백그라운드 진행 */ }
          return cached;
        }
        return (await network) || Response.error();
      })()
    );
    return;
  }

  /* 2) Firebase Storage 사진 → 서비스워커가 관여하지 않는다.
        blob 캐시는 앱의 IndexedDB가 담당하고, HTTP 캐시는 업로드 시 붙인
        `immutable, 1년` 헤더가 담당한다. 여기서 가로채면 no-cors 응답이
        cors 요청에 섞여 들어가는 오염이 재발한다. */
  if (host.includes("firebasestorage")) return;

  /* 3) Google Fonts → 폰트 파일은 cache-first, CSS는 SWR */
  if (host === "fonts.gstatic.com") {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
  if (host === "fonts.googleapis.com") {
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
    return;
  }

  /* 4) Firebase Auth / Firestore / 기타 구글 API → 항상 네트워크 (캐시 안 함) */
  if (
    host.includes("googleapis.com") ||
    host.includes("gstatic.com") ||
    host.includes("firebaseio.com") ||
    host.includes("identitytoolkit") ||
    host.includes("securetoken") ||
    host.endsWith("google.com")
  ) {
    return;
  }

  /* 5) 동일 출처 */
  if (url.origin === self.location.origin) {
    // 5-a) 해시가 붙은 빌드 산출물(/assets/index-abc123.js)은 내용 불변 → cache-first
    if (url.pathname.includes("/assets/")) {
      event.respondWith(cacheFirst(request, ASSET_CACHE));
      return;
    }
    // 5-b) 아이콘 등 나머지 정적 파일
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
  }
});
