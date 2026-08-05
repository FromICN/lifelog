/* ================================================================
   일회성 마이그레이션: 기존 Drive 백업 JSON → Firestore
   - 기존 JSON 구조 (Drive 백업 lifelog-backup-YYYY-MM-DD.json):
     [{ id, date, mood, location, text, scrapped?,
        images: [{ type:"photo", value:<dataURL> } |
                 { type:"gradient", value, label }] }]
   - dataURL 사진은 압축 → Storage 업로드 후 경로로 치환
   - 주의: 같은 파일을 두 번 가져오면 중복 생성됩니다 (1회만 실행)
   ================================================================ */
import { collection, getDocs, doc, updateDoc } from "firebase/firestore";
import { db, getStorageLazy } from "./firebase";
import { createLog } from "./db";
import { compressThumb, compressMicro, thumbPathFor, primePhotoURL, IMG_CACHE_CONTROL } from "./photos";
import { putThumb } from "./thumbcache";
import { count, setInfo } from "./perf";

const dataURLtoBlob = async (dataURL) => (await fetch(dataURL)).blob();

export async function importLegacyJSON(uid, json, onProgress) {
  const list = Array.isArray(json) ? json : null;
  if (!list) throw new Error("잘못된 백업 파일 형식입니다 (JSON 배열이 아님)");

  let done = 0;
  for (const old of list) {
    const images = [];
    for (const img of old.images || []) {
      if (img.type === "photo" && typeof img.value === "string" && img.value.startsWith("data:")) {
        images.push({ type: "photo", file: await dataURLtoBlob(img.value) });
      } else if (img.type === "gradient") {
        images.push({ type: "gradient", value: img.value, label: img.label || "📷" });
      }
    }
    await createLog(uid, {
      date: old.date || new Date().toISOString().slice(0, 10),
      mood: old.mood || null,
      location: old.location || "",
      text: old.text || "",
      scrapped: !!old.scrapped,
      images,
    });
    onProgress?.(++done, list.length);
  }
  return done;
}

/* ================================================================
   기존 사진 백필: 썸네일 + 초소형 미리보기(micro) + URL 채우기 (1회 실행)
   - 대상: images[] 중 type=photo이고 thumbURL 또는 micro가 없는 항목
   - 썸네일이 없으면 원본을 받아 400px 썸네일을 만들어 Storage에 올리고,
     micro가 없으면 (되도록 이미 있는 작은 썸네일에서) 32px 미리보기를 만들어
     문서에 base64로 내장 → 접속 즉시 첫 렌더에 사진이 그려진다.
   - 업로드에는 장기 불변 캐시 헤더를 붙여 재방문 로딩도 빨라진다.
   - 실패한 사진은 원본 그대로 두고 계속 진행
   ================================================================ */
export async function backfillPhotos(uid, onProgress) {
  const { ref, getDownloadURL, uploadBytes, storage } = await getStorageLazy();
  const snap = await getDocs(collection(db, "users", uid, "logs"));
  const docs = snap.docs;

  const needsWork = (img) => img.type === "photo" && img.path && (!img.thumbURL || !img.micro);
  const total = docs.reduce(
    (n, d) => n + (d.data().images || []).filter(needsWork).length,
    0
  );
  let done = 0;
  let failed = 0;
  onProgress?.(0, total);
  if (total === 0) return { done: 0, failed: 0 };

  const meta = { contentType: "image/webp", cacheControl: IMG_CACHE_CONTROL };
  const fetchBlob = async (url) => (await fetch(url)).blob();

  for (const d of docs) {
    const images = d.data().images || [];
    let changed = false;
    const next = [];
    for (const img of images) {
      if (!needsWork(img)) { next.push(img); continue; }
      try {
        let { url: fullURL, thumbURL, micro } = img;
        const thumbPath = img.thumbPath || thumbPathFor(img.path);
        let thumbBlob = null;

        // 1) 썸네일이 없으면 원본에서 생성해 업로드
        if (!thumbURL) {
          fullURL = fullURL || (await getDownloadURL(ref(storage, img.path)));
          const blob = await fetchBlob(fullURL);
          thumbBlob = await compressThumb(blob);
          const thumbRef = ref(storage, thumbPath);
          await uploadBytes(thumbRef, thumbBlob, meta);
          thumbURL = await getDownloadURL(thumbRef);
          primePhotoURL(img.path, fullURL);
          primePhotoURL(thumbPath, thumbURL);
          putThumb(thumbPath, thumbBlob); // 이 기기 로컬 캐시에도 저장
        }

        // 2) micro가 없으면 (가능하면 작은 썸네일에서) 32px 미리보기 생성
        if (!micro) {
          let srcBlob = thumbBlob;
          if (!srcBlob) {
            const u = thumbURL || fullURL || (await getDownloadURL(ref(storage, img.path)));
            srcBlob = await fetchBlob(u);
            /* 이미 받은 썸네일이니 로컬 캐시에도 넣어 둔다(다운로드 낭비 방지) */
            if (thumbURL) putThumb(thumbPath, srcBlob);
          }
          micro = await compressMicro(srcBlob);
        }

        next.push({ ...img, url: fullURL || img.url, thumbPath, thumbURL, micro });
        count("백필 성공");
        changed = true;
      } catch (e) {
        /* 왜 실패했는지 진단에 남긴다. Storage에 파일이 실제로 없으면
           storage/object-not-found 가 찍힌다 → 그 사진은 복구 불가. */
        count("백필 실패");
        failed++;
        setInfo("백필 실패 원인", `${e.code || e.name}: ${e.message}`.slice(0, 120));
        console.error("사진 백필 실패:", img.path, e);
        next.push(img);
      } finally {
        onProgress?.(++done, total);
      }
    }
    if (changed) {
      await updateDoc(doc(db, "users", uid, "logs", d.id), { images: next });
    }
  }
  return { done: done - failed, failed };
}
