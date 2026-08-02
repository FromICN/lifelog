/* ================================================================
   일회성 마이그레이션: 기존 Drive 백업 JSON → Firestore
   - 기존 JSON 구조 (Drive 백업 lifelog-backup-YYYY-MM-DD.json):
     [{ id, date, mood, location, text, scrapped?,
        images: [{ type:"photo", value:<dataURL> } |
                 { type:"gradient", value, label }] }]
   - dataURL 사진은 압축 → Storage 업로드 후 경로로 치환
   - 주의: 같은 파일을 두 번 가져오면 중복 생성됩니다 (1회만 실행)
   ================================================================ */
import { createLog } from "./db";

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
