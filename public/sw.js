/* ================================================================
   LifeLog PWA 서비스워커
   - 앱 셸/정적 자산: stale-while-revalidate (오프라인 실행)
   - Firebase Storage 사진: cache-first (오프라인에서도 사진 표시)
   - Firebase Auth/Firestore/API: 항상 네트워크 (캐시하지 않음)
   버전을 올리면(CACHE) 이전 캐시는 자동 삭제됩니다.
   ================================================================ */
const CACHE = "lifelog-v1";
const SCOPE = self.registration.scope; // 예: https://fromicn.github.io/lifelog/
const SHELL = [SCOPE, SCOPE + "index.html", SCOPE + "manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try { await cache.addAll(SHELL); } catch (_) { /* 일부 404여도 무시 */ }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((resp) => {
      if (resp && resp.status === 200 && (resp.type === "basic" || resp.type === "cors"))
        cache.put(request, resp.clone());
      return resp;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    if (resp && resp.status === 200) cache.put(request, resp.clone());
    return resp;
  } catch (_) {
    return cached || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  let url;
  try { url = new URL(request.url); } catch (_) { return; }
  const host = url.hostname;

  // 1) 페이지 내비게이션 → 네트워크 우선, 실패 시 캐시된 셸
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try { return await fetch(request); }
        catch (_) {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match(SCOPE + "index.html")) ||
            (await cache.match(SCOPE)) ||
            Response.error()
          );
        }
      })()
    );
    return;
  }

  // 2) Firebase Storage 사진 → cache-first
  if (host.includes("firebasestorage")) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 3) Google Fonts → stale-while-revalidate
  if (host === "fonts.googleapis.com" || host === "fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // 4) Firebase Auth / Firestore / 기타 구글 API → 항상 네트워크 (캐시 안 함)
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

  // 5) 동일 출처 앱 자산(JS/CSS/이미지 등) → stale-while-revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
