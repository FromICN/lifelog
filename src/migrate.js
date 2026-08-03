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
import { ref, getDownloadURL, uploadBytes } from "firebase/storage";
import { db, storage } from "./firebase";
import { createLog } from "./db";
import { compressThumb, thumbPathFor, primePhotoURL } from "./photos";

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
   기존 사진 백필: 썸네일 생성 + 다운로드 URL 채우기 (1회 실행)
   - 대상: images[] 중 type=photo이고 thumbURL이 없는 항목
   - 원본을 받아 400px 썸네일을 만들어 Storage에 올리고,
     문서에 url/thumbPath/thumbURL을 채워 이후 접속 시 왕복을 없앰
   - 실패한 사진은 원본 그대로 두고 계속 진행
   ================================================================ */
export async function backfillPhotos(uid, onProgress) {
  const snap = await getDocs(collection(db, "users", uid, "logs"));
  const docs = snap.docs;

  const needsWork = (img) => img.type === "photo" && img.path && !img.thumbURL;
  const total = docs.reduce(
    (n, d) => n + (d.data().images || []).filter(needsWork).length,
    0
  );
  let done = 0;
  onProgress?.(0, total);
  if (total === 0) return 0;

  for (const d of docs) {
    const images = d.data().images || [];
    let changed = false;
    const next = [];
    for (const img of images) {
      if (!needsWork(img)) { next.push(img); continue; }
      try {
        const fullURL = img.url || (await getDownloadURL(ref(storage, img.path)));
        const blob = await (await fetch(fullURL)).blob();
        const thumbBlob = await compressThumb(blob);
        const thumbPath = img.thumbPath || thumbPathFor(img.path);
        const thumbRef = ref(storage, thumbPath);
        await uploadBytes(thumbRef, thumbBlob, { contentType: "image/webp" });
        const thumbURL = await getDownloadURL(thumbRef);
        primePhotoURL(img.path, fullURL);
        primePhotoURL(thumbPath, thumbURL);
        next.push({ ...img, url: fullURL, thumbPath, thumbURL });
        changed = true;
      } catch (e) {
        console.error("썸네일 백필 실패:", img.path, e);
        next.push(img);
      } finally {
        onProgress?.(++done, total);
      }
    }
    if (changed) {
      await updateDoc(doc(db, "users", uid, "logs", d.id), { images: next });
    }
  }
  return done;
}
