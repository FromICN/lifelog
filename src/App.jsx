import React, { useState, useMemo, useRef, useEffect, createContext, useContext } from "react";
import {
  Calendar as CalendarIcon, LayoutGrid, Plus, BarChart3, User,
  Search, Settings, X, ChevronLeft, ChevronRight, ChevronDown,
  MapPin, LocateFixed, Trash2, Pencil, Bookmark, MoreHorizontal,
  Image as ImageIcon, Layers, Hash, Moon, Sun,
  LogOut, Loader2, Check, UploadCloud, Rows,
  RotateCcw, RotateCw, Crop, SlidersHorizontal,
  Sparkles, BookOpen, HeartPulse, Smile,
} from "lucide-react";
import { auth, CONFIG_READY, signInWithGoogle, logOut } from "./firebase";
import { onAuthStateChanged } from "firebase/auth";
import { subscribeLogs, createLog, updateLog, deleteLog, setScrap } from "./db";
import { getPhotoURL, invalidatePhotoURL } from "./photos";
import { loadThumb, peekThumbUrl, warmThumbs } from "./thumbcache";
/* migrate.js(백업 가져오기·사진 최적화)는 설정에서만 쓰므로 동적 import.
   초기 번들에서 제외되어 첫 실행이 그만큼 빨라집니다. */
const migrateMod = () => import("./migrate");

/* ================================================================
   LifeLog — "DayPic 스타일" 리디자인
   React + Tailwind CSS + lucide-react

   레퍼런스(DayPic) 핵심 디자인 언어:
   - 거대한 콘덴스드 대문자 월(月) 워드마크 + 작은 연도 (월별 액센트 컬러)
   - "이번 달 기록 X / N일 · %" 진행바
   - 캘린더(사진 셀) 홈 · 리스트(사진 타일) · 월간 리포트 · 프로필
   - 하단 5탭: 캘린더 · 리스트 · ⊕ · 리포트 · 프로필
   - 아주 밝고 미니멀한 화이트 배경 + 라운드 코너

   저장소/인증 로직(Firestore·Auth·Storage)은 기존 그대로 유지.
   기존 기능(기분·위치/GPS·해시태그·스크랩)도 모두 보존.
   ================================================================ */

/* ---------- 상수 ---------- */
/* 기분(마음)에 직접 고르는 이모지 팔레트.
   저장은 이모지 문자 그대로. (예: "😊")  */
const MOOD_EMOJIS = [
  "😊", "😄", "🥰", "😍", "🤩", "😌",
  "🙂", "😐", "😔", "😢", "😭", "😤",
  "😡", "😰", "😱", "🥺", "😴", "🤒",
  "🤕", "🥳", "🤗", "🤔", "😎", "😇",
  "☀️", "⛅", "☁️", "🌧️", "❄️", "🌈",
  "💗", "💪", "🔥", "✨", "🍀", "⭐",
];

/* 예전 버전에서 id로 저장된 기분과의 하위 호환 매핑 */
const LEGACY_MOODS = {
  sunny: { emoji: "☀️", label: "맑음" },
  cloudy: { emoji: "☁️", label: "흐림" },
  happy: { emoji: "😊", label: "행복" },
  calm: { emoji: "😌", label: "차분" },
  excited: { emoji: "💗", label: "설렘" },
  tired: { emoji: "😴", label: "피곤" },
};

/* 월별 대문자 라벨 + 액센트 컬러 (DayPic 시그니처: 달마다 색이 바뀜) */
const MONTHS_EN = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTH_ACCENTS = [
  "#5B8DEF", // JAN 겨울 블루
  "#B07CC9", // FEB 라벤더
  "#57B894", // MAR 민트
  "#F291B4", // APR 벚꽃 핑크
  "#5FC85A", // MAY 그린
  "#FF6A2C", // JUN 오렌지
  "#FF5D6C", // JUL 코랄
  "#22B2C6", // AUG 틸
  "#E0913A", // SEP 앰버
  "#F2B01E", // OCT 골드
  "#C0674C", // NOV 러스트
  "#4E9A87", // DEC 파인
];
const accentOf = (m) => MONTH_ACCENTS[((m % 12) + 12) % 12];

const todayStr = () => new Date().toISOString().slice(0, 10);
const pad2 = (n) => String(n).padStart(2, "0");

/* ---------- 유틸 ---------- */
const extractTags = (text) => (text.match(/#[^\s#]+/g) || []).map((t) => t.slice(1));
/* 저장된 mood(레거시 id 또는 이모지 문자) → { emoji, label } */
const moodView = (m) => {
  if (!m) return null;
  if (LEGACY_MOODS[m]) return LEGACY_MOODS[m];
  return { emoji: m, label: "" };
};
const fmtDate = (d) => {
  const [y, m, day] = d.split("-");
  return `${y}년 ${+m}월 ${+day}일`;
};
/* 'YYYY-MM-DD' → 로컬 Date (TZ 안전) */
const parseDate = (d) => { const [y, m, day] = d.split("-").map(Number); return new Date(y, m - 1, day); };
/* createdAt(Firestore Timestamp) → 시(hour) 또는 null */
const hourOf = (e) => {
  const t = e.createdAt;
  if (t && typeof t.toDate === "function") return t.toDate().getHours();
  return null;
};

/* ---------- 좌표 → 장소명 (Nominatim 역지오코딩, API 키 불필요) ---------- */
const reverseGeocode = async (lat, lon) => {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&accept-language=ko&zoom=16`,
      { headers: { Accept: "application/json" } }
    );
    const d = await r.json();
    const a = d.address || {};
    const name = [
      a.city || a.town || a.village || a.county || "",
      a.borough || a.city_district || a.district || "",
      a.suburb || a.neighbourhood || a.quarter || a.road || "",
    ].filter(Boolean).join(" ").trim();
    return (
      name ||
      (d.display_name ? d.display_name.split(",").slice(0, 2).map((s) => s.trim()).reverse().join(" ") : "") ||
      `${(+lat).toFixed(4)}, ${(+lon).toFixed(4)}`
    );
  } catch {
    return `${(+lat).toFixed(4)}, ${(+lon).toFixed(4)}`;
  }
};

/* ---------- GPS 현재 위치 → 장소명 ---------- */
const getCurrentPlace = () =>
  new Promise((resolve, reject) => {
    if (!navigator.geolocation)
      return reject(new Error("이 기기는 위치 기능을 지원하지 않아요"));
    navigator.geolocation.getCurrentPosition(
      async ({ coords: { latitude: lat, longitude: lon } }) => resolve(await reverseGeocode(lat, lon)),
      (err) =>
        reject(new Error(
          err.code === 1
            ? "위치 권한이 거부되었어요. 브라우저 설정에서 허용해주세요"
            : "현재 위치를 가져오지 못했어요. 잠시 후 다시 시도해주세요"
        )),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });

/* ---------- 사진 EXIF에서 GPS 좌표 추출 (JPEG, 라이브러리 없이 직접 파싱) ---------- */
function parseTiffGps(view, tiff) {
  const little = view.getUint16(tiff) === 0x4949; // "II" = little-endian
  const u16 = (o) => view.getUint16(o, little);
  const u32 = (o) => view.getUint32(o, little);
  if (u16(tiff + 2) !== 0x002a) return null;
  const ifd0 = tiff + u32(tiff + 4);
  const count0 = u16(ifd0);
  let gpsPtr = 0;
  for (let i = 0; i < count0; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (u16(entry) === 0x8825) { gpsPtr = tiff + u32(entry + 8); break; } // GPS IFD 포인터
  }
  if (!gpsPtr) return null;
  const gpsCount = u16(gpsPtr);
  const readRationals = (entry, n) => {
    const off = tiff + u32(entry + 8);
    const out = [];
    for (let k = 0; k < n; k++) {
      const num = u32(off + k * 8);
      const den = u32(off + k * 8 + 4);
      out.push(den ? num / den : 0);
    }
    return out;
  };
  let latRef, lonRef, lat, lon;
  for (let i = 0; i < gpsCount; i++) {
    const entry = gpsPtr + 2 + i * 12;
    const tag = u16(entry);
    if (tag === 1) latRef = String.fromCharCode(view.getUint8(entry + 8));
    else if (tag === 3) lonRef = String.fromCharCode(view.getUint8(entry + 8));
    else if (tag === 2) { const d = readRationals(entry, 3); lat = d[0] + d[1] / 60 + d[2] / 3600; }
    else if (tag === 4) { const d = readRationals(entry, 3); lon = d[0] + d[1] / 60 + d[2] / 3600; }
  }
  if (lat == null || lon == null) return null;
  if (latRef === "S") lat = -lat;
  if (lonRef === "W") lon = -lon;
  return { lat, lon };
}

function parseExifGps(view) {
  if (view.getUint16(0) !== 0xffd8) return null; // JPEG SOI
  const len = view.byteLength;
  let offset = 2;
  while (offset + 4 < len) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xe1) { // APP1 (EXIF)
      const app1 = offset + 4;
      if (view.getUint32(app1) !== 0x45786966) return null; // "Exif"
      return parseTiffGps(view, app1 + 6);
    }
    if (marker === 0xda) break; // SOS: 이미지 데이터 시작
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

/* 버퍼 어디에서든 "Exif\0\0" 시그니처를 찾아 그 뒤 TIFF 블록에서 GPS 추출.
   HEIC(아이폰 기본 포맷)·JPEG 등 컨테이너가 달라도 EXIF의 TIFF 구조는 동일해서,
   JPEG 마커 파싱이 실패할 때의 폴백으로 광범위하게 동작한다. */
function scanExifGps(view) {
  const len = view.byteLength;
  // "Exif" = 0x45 0x78 0x69 0x66, 그 뒤 0x00 0x00
  for (let i = 0; i + 8 < len; i++) {
    if (
      view.getUint8(i) === 0x45 && view.getUint8(i + 1) === 0x78 &&
      view.getUint8(i + 2) === 0x69 && view.getUint8(i + 3) === 0x66 &&
      view.getUint8(i + 4) === 0x00 && view.getUint8(i + 5) === 0x00
    ) {
      try {
        const gps = parseTiffGps(view, i + 6);
        if (gps) return gps;
      } catch { /* 계속 탐색 */ }
    }
  }
  return null;
}

const readExifGps = (file) =>
  new Promise((resolve) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const view = new DataView(e.target.result);
        // 1) 표준 JPEG APP1 경로  2) 실패 시 전체 스캔(HEIC 등)
        resolve(parseExifGps(view) || scanExifGps(view));
      } catch { resolve(null); }
    };
    reader.onerror = () => resolve(null);
    // EXIF/GPS는 보통 파일 앞부분에 있지만 HEIC는 더 뒤쪽일 수 있어 넉넉히 읽는다.
    reader.readAsArrayBuffer(file.slice(0, 1024 * 1024));
  });

/* 사진 파일 → EXIF GPS → 장소명 (없으면 null) */
const getPlaceFromFile = async (file) => {
  const gps = await readExifGps(file);
  if (!gps) return null;
  return reverseGeocode(gps.lat, gps.lon);
};

/* ---------- Context (전역 상태) ---------- */
const DiaryContext = createContext(null);
const useDiary = () => useContext(DiaryContext);

/* ---------- Storage 사진 (경로/URL → 표시) ----------
   - thumb=true이고 썸네일이 있으면: 로컬(IndexedDB) 캐시에서 먼저 로드
     (한 번 본/올린 썸네일은 이후 네트워크 없이 디스크에서 즉시 표시)
   - 캐시에 없으면 저장된 thumbURL(없으면 getDownloadURL)로 받아 로컬에 캐시
   - 원본(본문) 이미지는 로컬에 저장하지 않고 Storage에서 로드
   - loading=lazy·decoding=async, 로딩 중 스켈레톤, 만료 URL은 자동 재조회 */
/* 썸네일 로컬 캐시 키 (warmThumbs와 StoragePhoto가 반드시 같은 키를 써야 함) */
const thumbKeyOf = (img) =>
  (img && img.type === "photo" && (img.thumbPath || img.thumbURL)) || null;

/* 목록/캘린더에서 대표로 보여 주는 첫 사진의 썸네일 키들 */
const listThumbKeys = (entries) =>
  entries.map((e) => thumbKeyOf((e.images || [])[0])).filter(Boolean);

function StoragePhoto({ img, thumb = false, className = "" }) {
  const isPhoto = img.type === "photo";
  const hasThumb = isPhoto && !!(img.thumbPath || img.thumbURL);
  const useLocal = thumb && hasThumb && !img.preview;
  const cacheKey = useLocal ? thumbKeyOf(img) : null;

  const directURL =
    img.preview || (thumb ? img.thumbURL || img.url : img.url) || null;
  const netPath = (thumb ? img.thumbPath || img.path : img.path) || null;

  const [url, setUrl] = useState(() =>
    useLocal ? peekThumbUrl(cacheKey) : directURL
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let on = true;
    setFailed(false);

    if (img.preview) { setUrl(img.preview); return; }

    if (useLocal) {
      const mem = peekThumbUrl(cacheKey);
      if (mem) { setUrl(mem); return; }
      setUrl(null);
      loadThumb(cacheKey, async () => {
        const u = img.thumbURL || (await getPhotoURL(img.thumbPath || img.path));
        const res = await fetch(u);
        if (!res.ok) throw new Error("thumb fetch 실패");
        return await res.blob();
      })
        .then((u) => { if (on) setUrl(u || directURL || null); })
        .catch(() => { if (on) setUrl(directURL || null); });
      return () => { on = false; };
    }

    if (directURL) { setUrl(directURL); return; }
    if (!netPath) { setUrl(null); return; }
    setUrl(null);
    getPhotoURL(netPath)
      .then((u) => on && setUrl(u))
      .catch(() => on && setUrl(null));
    return () => { on = false; };
  }, [useLocal, cacheKey, directURL, netPath, img.preview]);

  /* 저장/캐시된 URL이 만료·무효면 한 번 무효화 후 네트워크 재조회 */
  const handleError = () => {
    if (failed) { setUrl(null); return; }
    setFailed(true);
    const p = img.thumbPath || img.path;
    if (!p) { setUrl(null); return; }
    invalidatePhotoURL(p);
    getPhotoURL(p).then(setUrl).catch(() => setUrl(null));
  };

  if (!url)
    return (
      <div className={`w-full h-full flex items-center justify-center bg-neutral-500/10 animate-pulse ${className}`}>
        <ImageIcon size={22} className="opacity-20" />
      </div>
    );
  return (
    <img
      src={url}
      alt="diary"
      loading="lazy"
      decoding="async"
      onError={handleError}
      className={`object-cover w-full h-full ${className}`}
    />
  );
}

/* ---------- 공용: 이미지(사진 or 그라디언트) ---------- */
function Img({ img, thumb = false, className = "" }) {
  if (!img) return <div className={`w-full h-full bg-neutral-500/10 ${className}`} />;
  if (img.type === "photo") return <StoragePhoto img={img} thumb={thumb} className={className} />;
  return (
    <div className={`w-full h-full flex items-center justify-center ${img.value} ${className}`}>
      <span className="text-4xl drop-shadow">{img.label || "📷"}</span>
    </div>
  );
}

/* ---------- 이미지 캐러셀 (좌우 스와이프) ---------- */
function Carousel({ images, rounded = "" }) {
  const [idx, setIdx] = useState(0);
  const startX = useRef(null);
  if (!images.length) return null;
  const go = (d) => setIdx((i) => Math.max(0, Math.min(images.length - 1, i + d)));
  return (
    <div
      className={`relative aspect-square overflow-hidden select-none ${rounded}`}
      onTouchStart={(e) => (startX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (startX.current == null) return;
        const dx = e.changedTouches[0].clientX - startX.current;
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
        startX.current = null;
      }}
    >
      <div className="flex h-full transition-transform duration-300 ease-out"
        style={{ transform: `translateX(-${idx * 100}%)` }}>
        {images.map((img, i) => (
          <div key={i} className="w-full h-full flex-shrink-0"><Img img={img} /></div>
        ))}
      </div>
      {images.length > 1 && (
        <>
          {idx > 0 && (
            <button onClick={() => go(-1)}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white/80 flex items-center justify-center shadow hover:bg-white">
              <ChevronLeft size={16} className="text-neutral-700" />
            </button>
          )}
          {idx < images.length - 1 && (
            <button onClick={() => go(1)}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white/80 flex items-center justify-center shadow hover:bg-white">
              <ChevronRight size={16} className="text-neutral-700" />
            </button>
          )}
          <div className="absolute top-3 right-3 px-2 py-0.5 rounded-full bg-black/60 text-white text-xs font-medium">
            {idx + 1}/{images.length}
          </div>
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
            {images.map((_, i) => (
              <span key={i} className={`w-1.5 h-1.5 rounded-full transition-colors ${i === idx ? "bg-white" : "bg-white/50"}`} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- 본문 텍스트 (해시태그 하이라이트 + 클릭 검색) ---------- */
function RichText({ text }) {
  const { T, accent, openSearch } = useDiary();
  return (
    <p className={`text-sm leading-relaxed whitespace-pre-wrap ${T.text}`}>
      {text.split(/(#[^\s#]+)/g).map((part, i) =>
        part.startsWith("#") ? (
          <button key={i}
            onClick={() => openSearch(part.slice(1))}
            className="font-medium hover:underline" style={{ color: accent }}>{part}</button>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </p>
  );
}

/* ---------- 일기 카드 (상세/피드/스크랩 공용) ---------- */
function DiaryCard({ entry }) {
  const { T, accent, uname, deleteEntry, openEdit, toggleScrap } = useDiary();
  const [menu, setMenu] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const mood = moodView(entry.mood);

  return (
    <article className={`${T.card} border ${T.border} rounded-2xl overflow-hidden`}>
      {/* 헤더 */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-9 h-9 rounded-full flex items-center justify-center text-base"
          style={{ backgroundColor: accent + "22" }}>
          {mood?.emoji || "📔"}
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-semibold ${T.text} flex items-center gap-2`}>
            {fmtDate(entry.date)}
            {mood && <span className={`text-xs font-normal ${T.sub}`}>{mood.emoji}{mood.label ? ` ${mood.label}` : ""}</span>}
          </div>
          <div className={`text-xs ${T.sub} flex items-center gap-1 truncate`}>
            {entry.location
              ? (<><MapPin size={11} /><span className="truncate">{entry.location}</span></>)
              : <span className="opacity-70">{uname}</span>}
          </div>
        </div>
        <div className="relative">
          <button onClick={() => { setMenu(!menu); setConfirmDel(false); }} className={`p-1 ${T.sub} hover:opacity-70`}>
            <MoreHorizontal size={20} />
          </button>
          {menu && (
            <div className={`absolute right-0 top-8 z-20 w-36 ${T.card} border ${T.border} rounded-xl shadow-lg overflow-hidden`}>
              <button onClick={() => { setMenu(false); openEdit(entry); }}
                className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm ${T.text} hover:bg-neutral-500/10`}>
                <Pencil size={14} /> 수정
              </button>
              <button
                onClick={() => { if (confirmDel) { deleteEntry(entry.id); setMenu(false); } else setConfirmDel(true); }}
                className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-red-500 hover:bg-red-500/10">
                <Trash2 size={14} /> {confirmDel ? "정말 삭제할까요?" : "삭제"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 이미지 캐러셀 */}
      <Carousel images={entry.images} />

      {/* 액션 바: 스크랩 */}
      <div className="flex items-center px-4 pt-3">
        <button onClick={() => toggleScrap(entry.id)} className="ml-auto hover:opacity-60 transition-opacity">
          <Bookmark size={22}
            className={entry.scrapped ? "" : T.icon}
            style={entry.scrapped ? { fill: accent, color: accent } : undefined}
            strokeWidth={1.7} />
        </button>
      </div>

      {/* 본문 (하이라이트 내용) */}
      {entry.text && (
        <div className="px-4 pb-1 pt-2">
          <RichText text={entry.text} />
        </div>
      )}

      {/* 오늘의 배움 · 오늘의 건강 */}
      <EntrySections entry={entry} />

      <div className="pb-3" />
    </article>
  );
}

/* 카드/상세에서 감사·아쉬움·몸·마음을 라벨과 함께 표시 (빈 항목은 생략) */
function EntrySections({ entry }) {
  const { T, accent } = useDiary();
  const mood = moodView(entry.mood);
  const learn = [
    { key: "gratitude", label: "감사", icon: "🙏", text: entry.gratitude },
    { key: "regret", label: "아쉬움", icon: "🌱", text: entry.regret },
  ].filter((r) => r.text && r.text.trim());
  const health = [
    { key: "body", label: "몸", icon: "💪", text: entry.body },
    { key: "mind", label: "마음", icon: mood?.emoji || "🧠", text: entry.mind },
  ].filter((r) => r.text && r.text.trim());

  if (learn.length === 0 && health.length === 0) return null;

  const Row = ({ icon, label, text }) => (
    <div className="flex gap-2">
      <span className="text-sm leading-relaxed w-5 text-center flex-shrink-0">{icon}</span>
      <div className="min-w-0">
        <span className="text-[11px] font-semibold mr-1.5" style={{ color: accent }}>{label}</span>
        <span className={`text-sm leading-relaxed whitespace-pre-wrap ${T.text}`}>{text}</span>
      </div>
    </div>
  );

  return (
    <div className="px-4 pt-2 space-y-3">
      {learn.length > 0 && (
        <div className={`rounded-xl ${T.input} px-3 py-2.5 space-y-1.5`}>
          <div className={`text-[11px] font-bold tracking-wide ${T.sub} flex items-center gap-1`}>
            <BookOpen size={12} /> 오늘의 배움
          </div>
          {learn.map((r) => <Row key={r.key} {...r} />)}
        </div>
      )}
      {health.length > 0 && (
        <div className={`rounded-xl ${T.input} px-3 py-2.5 space-y-1.5`}>
          <div className={`text-[11px] font-bold tracking-wide ${T.sub} flex items-center gap-1`}>
            <HeartPulse size={12} /> 오늘의 건강
          </div>
          {health.map((r) => <Row key={r.key} {...r} />)}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   월 헤더 (거대한 워드마크 + 진행바)
   ================================================================ */
function MonthHeader({ overline, right }) {
  const { T, accent, month, setMonth, monthEntries, entries } = useDiary();
  const [picker, setPicker] = useState(false);
  const daysInMonth = new Date(month.y, month.m + 1, 0).getDate();
  const recorded = new Set(monthEntries.map((e) => e.date)).size;
  const pct = daysInMonth ? (recorded / daysInMonth) * 100 : 0;
  const monthsWith = useMemo(
    () => new Set(entries.map((e) => e.date.slice(0, 7))),
    [entries]
  );

  return (
    <div className="px-4 pt-3">
      {overline && (
        <div className={`text-[11px] font-bold tracking-[0.2em] ${T.sub} mb-0.5`}>{overline}</div>
      )}
      <div className="flex items-start justify-between">
        <div className="relative">
          <button onClick={() => setPicker((v) => !v)} className="flex items-end gap-2 group">
            <span className="font-display text-6xl leading-[0.85]" style={{ color: accent }}>
              {MONTHS_EN[month.m]}
            </span>
            <span className="font-semibold text-base mb-1" style={{ color: accent }}>{month.y}</span>
            <ChevronDown size={16} className="mb-2 -ml-1 opacity-70 group-hover:opacity-100" style={{ color: accent }} />
          </button>

          {picker && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setPicker(false)} />
              <div className={`absolute left-0 top-full mt-2 z-40 w-64 ${T.card} border ${T.border} rounded-2xl shadow-xl p-3`}>
                <div className="flex items-center justify-between mb-2">
                  <button onClick={() => setMonth((s) => ({ ...s, y: s.y - 1 }))} className={`p-1.5 rounded-lg hover:bg-neutral-500/10 ${T.sub}`}><ChevronLeft size={16} /></button>
                  <span className={`text-sm font-bold ${T.text}`}>{month.y}</span>
                  <button onClick={() => setMonth((s) => ({ ...s, y: s.y + 1 }))} className={`p-1.5 rounded-lg hover:bg-neutral-500/10 ${T.sub}`}><ChevronRight size={16} /></button>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {MONTHS_EN.map((lbl, i) => {
                    const on = i === month.m;
                    const has = monthsWith.has(`${month.y}-${pad2(i + 1)}`);
                    return (
                      <button key={lbl}
                        onClick={() => { setMonth((s) => ({ ...s, m: i })); setPicker(false); }}
                        className={`py-1.5 rounded-lg text-xs font-bold transition-colors ${on ? "text-white" : `${T.text} hover:bg-neutral-500/10`}`}
                        style={on ? { backgroundColor: accentOf(i) } : undefined}>
                        {lbl}
                        {has && !on && <span className="block mx-auto mt-0.5 w-1 h-1 rounded-full" style={{ backgroundColor: accentOf(i) }} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 pt-1">{right}</div>
      </div>

      {/* 진행바 */}
      <div className="mt-3">
        <div className={`h-1.5 rounded-full overflow-hidden`} style={{ backgroundColor: accent + "26" }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: accent }} />
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <span className={`text-xs ${T.sub}`}>이번 달 기록 <b className={T.text}>{recorded}</b> / {daysInMonth}일</span>
          <span className="text-xs font-semibold" style={{ color: accent }}>{pct.toFixed(1)} %</span>
        </div>
      </div>
    </div>
  );
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/* ---------- 캘린더 뷰 (홈) — 사진 셀 ---------- */
function CalendarView() {
  const { T, accent, month, monthEntries, openDay } = useDiary();
  const byDate = useMemo(() => {
    const map = {};
    monthEntries.forEach((e) => { (map[e.date] = map[e.date] || []).push(e); });
    return map;
  }, [monthEntries]);

  const first = new Date(month.y, month.m, 1).getDay();
  const days = new Date(month.y, month.m + 1, 0).getDate();
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];

  return (
    <div className="px-3 mt-4">
      <div className="grid grid-cols-7 mb-2">
        {WEEKDAYS.map((d, i) => (
          <div key={d} className={`text-center text-[11px] font-semibold py-1 ${i === 0 ? "text-red-400" : T.sub}`}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-[3px]">
        {cells.map((day, i) => {
          if (!day) return <div key={`e${i}`} className="aspect-square" />;
          const key = `${month.y}-${pad2(month.m + 1)}-${pad2(day)}`;
          const list = byDate[key];
          const isToday = key === todayStr();
          if (!list) {
            return (
              <div key={key}
                className={`aspect-square rounded-lg flex items-start justify-start p-1 ${isToday ? "ring-2" : ""}`}
                style={isToday ? { boxShadow: `inset 0 0 0 2px ${accent}` } : undefined}>
                <span className={`text-[11px] ${T.sub} opacity-60`}>{day}</span>
              </div>
            );
          }
          return (
            <button key={key} onClick={() => openDay(list)}
              className={`relative aspect-square rounded-lg overflow-hidden group ${isToday ? "ring-2" : ""}`}
              style={isToday ? { boxShadow: `0 0 0 2px ${accent}` } : undefined}>
              <Img img={list[0].images[0]} thumb />
              <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-transparent" />
              <span className="absolute top-1 left-1.5 text-[11px] font-bold text-white drop-shadow">{day}</span>
              {(list.length > 1 || list[0].images.length > 1) && (
                <Layers size={13} className="absolute top-1 right-1 text-white drop-shadow" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- 격자 뷰 — 월간 사진 타일 (3열, 정사각형) ---------- */
function GridView() {
  const { T, monthEntries, openEntry } = useDiary();
  const sorted = useMemo(
    () => [...monthEntries].sort((a, b) => b.date.localeCompare(a.date)),
    [monthEntries]
  );
  if (sorted.length === 0) return <EmptyMonth T={T} />;
  return (
    <div className="grid grid-cols-3 gap-[3px] px-3 mt-3">
      {sorted.map((e) => (
        <button key={e.id} onClick={() => openEntry(e)} className="relative aspect-square rounded-lg overflow-hidden group">
          <Img img={e.images[0]} thumb />
          <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-transparent" />
          <span className="absolute top-1.5 left-2 text-xs font-bold text-white drop-shadow">{+e.date.slice(8)}</span>
          {e.images.length > 1 && <Layers size={14} className="absolute top-1.5 right-1.5 text-white drop-shadow" />}
        </button>
      ))}
    </div>
  );
}

/* ---------- 피드 뷰 — 월간 일기 카드 ---------- */
function FeedView() {
  const { T, monthEntries } = useDiary();
  const sorted = useMemo(
    () => [...monthEntries].sort((a, b) => b.date.localeCompare(a.date)),
    [monthEntries]
  );
  if (sorted.length === 0) return <EmptyMonth T={T} />;
  return (
    <div className="max-w-md mx-auto px-4 space-y-4 mt-4">
      {sorted.map((e) => <DiaryCard key={e.id} entry={e} />)}
    </div>
  );
}

function EmptyMonth({ T }) {
  return (
    <div className={`text-center py-20 ${T.sub} text-sm`}>
      <ImageIcon size={40} className="mx-auto mb-3 opacity-40" />
      이번 달 기록이 아직 없어요
    </div>
  );
}

/* ---------- 홈 뷰 — 캘린더 · 격자 · 피드 (탭 통합) ---------- */
const HOME_TABS = [
  { id: "calendar", icon: CalendarIcon, label: "캘린더" },
  { id: "grid", icon: LayoutGrid, label: "격자" },
  { id: "feed", icon: Rows, label: "피드" },
];
function HomeView() {
  const { T, accent, dark } = useDiary();
  const [tab, setTab] = useState("calendar"); // calendar | grid | feed
  return (
    <div className="mt-2">
      {tab === "calendar" && <CalendarView />}
      {tab === "grid" && <GridView />}
      {tab === "feed" && <FeedView />}
      {/* 캘린더·격자·피드 탭을 엄지가 닿기 쉬운 하단(전역 내비 바 위)에 띄운다 */}
      <div className="fixed inset-x-0 bottom-[74px] z-30 flex justify-center pointer-events-none">
        <div className="pointer-events-auto inline-flex p-0.5 rounded-full shadow-lg backdrop-blur"
          style={{ backgroundColor: dark ? "rgba(38,39,44,0.92)" : "rgba(255,255,255,0.92)", boxShadow: "0 4px 16px rgba(0,0,0,0.18)" }}>
          {HOME_TABS.map(({ id, icon: Icon, label }) => {
            const on = tab === id;
            return (
              <button key={id} onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold transition-colors ${on ? "text-white" : T.sub}`}
                style={on ? { backgroundColor: accent } : undefined}>
                <Icon size={13} /> {label}
              </button>
            );
          })}
        </div>
      </div>
      {/* 떠 있는 탭에 콘텐츠가 가리지 않도록 하단 여백 */}
      <div className="h-14" />
    </div>
  );
}

/* ---------- 막대 그래프 (리포트 공용) ---------- */
function Bars({ data, accent, T, showCount = true }) {
  const max = Math.max(1, ...data.map((d) => d.v));
  return (
    <div className="flex items-end justify-between gap-1.5 h-28">
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center justify-end h-full">
          <div className="w-full flex-1 flex items-end justify-center">
            <div className="w-2 rounded-full transition-all"
              style={{ height: `${(d.v / max) * 100}%`, minHeight: d.v ? 6 : 4, backgroundColor: d.v ? accent : accent + "33" }} />
          </div>
          <div className={`mt-2 text-[11px] font-medium ${T.sub}`}>{d.label}</div>
          {showCount && <div className={`text-[10px] ${T.sub} opacity-70`}>{d.v}회</div>}
        </div>
      ))}
    </div>
  );
}

/* ---------- 통계 뷰 (최근 365일 기준) ---------- */
function ReportView() {
  const { T, accent, entries } = useDiary();

  /* 최근 365일 윈도우 */
  const { yearEntries, sinceStr } = useMemo(() => {
    const now = new Date();
    const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 364);
    const s = `${since.getFullYear()}-${pad2(since.getMonth() + 1)}-${pad2(since.getDate())}`;
    return { yearEntries: entries.filter((e) => e.date >= s), sinceStr: s };
  }, [entries]);

  const recordedDays = useMemo(() => new Set(yearEntries.map((e) => e.date)).size, [yearEntries]);
  const pct = (recordedDays / 365) * 100;
  const tagCount = useMemo(() => new Set(yearEntries.flatMap((e) => extractTags(e.text))).size, [yearEntries]);
  const activeMonths = useMemo(() => new Set(yearEntries.map((e) => e.date.slice(0, 7))).size, [yearEntries]);

  const weekday = useMemo(() => {
    const c = [0, 0, 0, 0, 0, 0, 0];
    yearEntries.forEach((e) => { c[parseDate(e.date).getDay()]++; });
    return ["일", "월", "화", "수", "목", "금", "토"].map((label, i) => ({ label, v: c[i] }));
  }, [yearEntries]);

  const timeOfDay = useMemo(() => {
    const c = [0, 0, 0, 0, 0, 0];
    yearEntries.forEach((e) => { const h = hourOf(e); if (h != null) c[Math.floor(h / 4)]++; });
    return ["0-4", "4-8", "8-12", "12-16", "16-20", "20-24"].map((label, i) => ({ label, v: c[i] }));
  }, [yearEntries]);

  const monthly = useMemo(() => {
    const now = new Date();
    const buckets = [];
    const map = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
      const b = { key, label: `${d.getMonth() + 1}`, v: 0 };
      buckets.push(b); map[key] = b;
    }
    yearEntries.forEach((e) => { const b = map[e.date.slice(0, 7)]; if (b) b.v++; });
    return buckets;
  }, [yearEntries]);

  const words = useMemo(() => {
    const cnt = {};
    yearEntries.forEach((e) => extractTags(e.text).forEach((t) => { cnt[t] = (cnt[t] || 0) + 1; }));
    let arr = Object.entries(cnt).map(([w, v]) => ({ w, v }));
    if (arr.length === 0) {
      const mc = {};
      yearEntries.forEach((e) => { const m = moodView(e.mood); if (m) { const k = m.emoji; mc[k] = (mc[k] || 0) + 1; } });
      arr = Object.entries(mc).map(([w, v]) => ({ w, v }));
    }
    return arr.sort((a, b) => b.v - a.v).slice(0, 5);
  }, [yearEntries]);
  const wordMax = Math.max(1, ...words.map((w) => w.v));
  const hasTime = timeOfDay.some((t) => t.v > 0);

  const Stat = ({ n, label }) => (
    <div className="text-center">
      <div className={`text-lg font-bold ${T.text}`}>{n}</div>
      <div className={`text-[11px] ${T.sub}`}>{label}</div>
    </div>
  );
  const Card = ({ title, children }) => (
    <div className={`rounded-2xl border ${T.border} p-4 ${T.card}`}>
      <div className={`text-[11px] font-semibold ${T.sub} mb-3`}>{title}</div>
      {children}
    </div>
  );

  return (
    <div className="max-w-md mx-auto pb-4">
      <div className="px-4 pt-6 pb-1">
        <div className={`text-[11px] font-bold tracking-[0.2em] ${T.sub}`}>LIFELOG</div>
        <div className={`text-xl font-bold ${T.text}`}>통계</div>
      </div>
      <div className="px-4 mt-3 space-y-4">
        {/* OVERVIEW · 최근 365일 */}
        <div className="rounded-2xl p-4" style={{ boxShadow: `0 0 0 2px ${accent}` }}>
          <div className={`text-[11px] font-bold tracking-widest ${T.sub} mb-1`}>OVERVIEW · 최근 365일</div>
          <div className="flex items-end justify-between">
            <div className="flex items-end gap-1">
              <span className="text-3xl font-extrabold" style={{ color: accent }}>{recordedDays}</span>
              <span className={`text-sm ${T.sub} mb-1`}>/ 365일</span>
            </div>
            <span className={`text-sm font-semibold ${T.text}`}>{pct.toFixed(1)}% 기록</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden mt-2" style={{ backgroundColor: accent + "26" }}>
            <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: accent }} />
          </div>
          <div className={`grid grid-cols-3 gap-2 mt-4 pt-4 border-t ${T.border}`}>
            <Stat n={yearEntries.length} label="총 기록" />
            <Stat n={tagCount} label="태그" />
            <Stat n={activeMonths} label="기록한 달" />
          </div>
        </div>

        {/* 시간대별 */}
        {hasTime && (
          <Card title="시간대별 기록">
            <Bars data={timeOfDay} accent={accent} T={T} />
          </Card>
        )}

        {/* 요일별 */}
        <Card title="요일별 기록">
          <Bars data={weekday} accent={accent} T={T} />
        </Card>

        {/* 월별 */}
        <Card title="월별 기록 (최근 12개월)">
          <Bars data={monthly} accent={accent} T={T} showCount={false} />
        </Card>

        {/* MY WORDS */}
        <div className={`rounded-2xl border ${T.border} p-4 ${T.card}`}>
          <div className={`text-[11px] font-bold tracking-widest ${T.sub} mb-3`}>MY WORDS</div>
          {words.length === 0 ? (
            <p className={`text-sm ${T.sub} py-4 text-center`}>#해시태그를 달면 자주 쓴 단어를 모아볼 수 있어요</p>
          ) : (
            <div className="space-y-2.5">
              {words.map((w, i) => (
                <div key={w.w} className="flex items-center gap-3">
                  <span className={`text-xs font-bold w-4 ${T.sub}`}>{i + 1}</span>
                  <span className={`text-sm font-medium ${T.text} w-16 truncate`}>{w.w}</span>
                  <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ backgroundColor: accent + "20" }}>
                    <div className="h-full rounded-full" style={{ width: `${(w.v / wordMax) * 100}%`, backgroundColor: accent }} />
                  </div>
                  <span className={`text-xs ${T.sub} w-6 text-right`}>{w.v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- 사진 모아보기 (마소너리) ---------- */
function PhotoWallModal({ onClose }) {
  const { T, entries, openEntry } = useDiary();
  const photos = useMemo(() => {
    const out = [];
    [...entries].sort((a, b) => b.date.localeCompare(a.date)).forEach((e) => {
      e.images.forEach((img) => out.push({ img, entry: e }));
    });
    return out;
  }, [entries]);

  /* 모아보기는 썸네일이 한꺼번에 많이 뜨므로 IndexedDB를 한 번에 읽어 둠 */
  useEffect(() => { warmThumbs(photos.map(({ img }) => thumbKeyOf(img))); }, [photos]);

  return (
    <div className={`fixed inset-0 z-50 ${T.bg} overflow-y-auto`}>
      <div className={`sticky top-0 z-10 ${T.card} border-b ${T.border}`}>
        <div className="max-w-md mx-auto flex items-center justify-between px-4 py-3">
          <button onClick={onClose} className={T.sub}><ChevronLeft size={22} /></button>
          <span className={`font-semibold text-sm ${T.text}`}>사진 모아보기</span>
          <span className="w-[22px]" />
        </div>
      </div>
      <div className="max-w-md mx-auto p-2">
        {photos.length === 0 ? (
          <div className={`text-center py-20 ${T.sub} text-sm`}>아직 사진이 없어요</div>
        ) : (
          <div className="[column-count:3] gap-1.5" style={{ columnGap: "6px" }}>
            {photos.map(({ img, entry }, i) => (
              <button key={i} onClick={() => openEntry(entry)}
                className="mb-1.5 w-full block rounded-lg overflow-hidden break-inside-avoid">
                <div className="w-full"><Img img={img} thumb className="!h-auto" /></div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- 검색 오버레이 ---------- */
function SearchOverlay({ onClose }) {
  const { T, accent, entries, filter, setFilter } = useDiary();
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(() => {
    return entries
      .filter((e) => {
        if (filter.mood && e.mood !== filter.mood) return false;
        if (filter.tag && !extractTags(e.text).includes(filter.tag)) return false;
        if (filter.query) {
          const q = filter.query.toLowerCase();
          if (!(`${e.text} ${e.location}`.toLowerCase().includes(q))) return false;
        }
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [entries, filter]);

  const active = filter.query || filter.mood || filter.tag;

  /* 실제로 쓰인 기분들만 칩으로 (자유 이모지 대응) */
  const usedMoods = useMemo(() => {
    const seen = new Map();
    entries.forEach((e) => {
      if (!e.mood || seen.has(e.mood)) return;
      seen.set(e.mood, moodView(e.mood));
    });
    return [...seen.entries()].map(([id, v]) => ({ id, ...v }));
  }, [entries]);

  return (
    <div className={`fixed inset-0 z-50 ${T.bg} overflow-y-auto`}>
      <div className={`sticky top-0 z-10 ${T.card} border-b ${T.border}`}>
        <div className="max-w-md mx-auto px-4 py-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <div className={`flex-1 flex items-center gap-2 ${T.input} rounded-full px-3 py-2`}>
              <Search size={16} className={T.sub} />
              <input ref={inputRef} value={filter.query}
                onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
                placeholder="내용·장소·태그 검색"
                className={`flex-1 bg-transparent text-sm outline-none ${T.text}`} />
              {filter.query && <button onClick={() => setFilter((f) => ({ ...f, query: "" }))}><X size={14} className={T.sub} /></button>}
            </div>
            <button onClick={onClose} className={`text-sm font-medium ${T.sub} px-1`}>닫기</button>
          </div>
          <div className="flex gap-2 overflow-x-auto no-scrollbar pb-0.5">
            {filter.tag && (
              <button onClick={() => setFilter((f) => ({ ...f, tag: null }))}
                className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full text-white text-xs font-medium"
                style={{ backgroundColor: accent }}>
                <Hash size={12} />{filter.tag}<X size={12} />
              </button>
            )}
            {usedMoods.map((m) => {
              const on = filter.mood === m.id;
              return (
                <button key={m.id}
                  onClick={() => setFilter((f) => ({ ...f, mood: on ? null : m.id }))}
                  className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${on ? "text-white border-transparent" : `${T.card} ${T.text} ${T.border} hover:opacity-70`}`}
                  style={on ? { backgroundColor: accent } : undefined}>
                  {m.emoji}{m.label ? ` ${m.label}` : ""}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="max-w-md mx-auto p-4 space-y-4">
        {!active ? (
          <div className={`text-center py-20 ${T.sub} text-sm`}>
            <Search size={40} className="mx-auto mb-3 opacity-40" />
            검색어를 입력하거나 기분·태그로 찾아보세요
          </div>
        ) : results.length === 0 ? (
          <div className={`text-center py-20 ${T.sub} text-sm`}>조건에 맞는 일기가 없어요</div>
        ) : (
          <>
            <div className={`text-xs ${T.sub}`}>{results.length}개의 일기</div>
            {results.map((e) => <DiaryCard key={e.id} entry={e} />)}
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- 작성 화면 공용: 섹션 제목 ---------- */
function SectionTitle({ icon: Icon, title, accent, T }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: accent + "1f", color: accent }}>
        <Icon size={15} />
      </span>
      <div className={`text-sm font-bold ${T.text}`}>{title}</div>
    </div>
  );
}

/* ---------- 기분 이모지 선택 (안드로이드/시스템 기본 이모지 활용) ---------- */
const EMOJI_GROUPS = [
  { name: "표정", items: "😀 😃 😄 😁 😆 😅 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 😌 😔 😪 🤤 😴".split(" ") },
  { name: "감정", items: "🥲 😢 😭 😤 😠 😡 🤬 😳 🥺 😨 😰 😥 😓 😩 😫 😖 😣 😞 😟 🙁 😕 😲 🤯 😱 🥱".split(" ") },
  { name: "상태", items: "🤗 🤭 🤫 🤔 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 😷 🤒 🤕 🤧 🥵 🥶 🤢 🥳 🤠 😎 🤓 🧐".split(" ") },
  { name: "하트·기호", items: "❤️ 🧡 💛 💚 💙 💜 🤍 🖤 💗 💖 💕 💞 💓 💔 ✨ ⭐ 🌟 🔥 💯 👍 👏 🙏 💪 🙌 🤝".split(" ") },
  { name: "날씨·자연", items: "☀️ 🌤️ ⛅ ☁️ 🌧️ ⛈️ 🌩️ 🌨️ ❄️ ☃️ 🌈 🌙 ⭐ 🌊 🍀 🌸 🌷 🌻 🌼 🌱 🍁 🍂 🌿 💐 🌵".split(" ") },
  { name: "활동·기타", items: "🏃 🚶 🧘 🛌 💤 ☕ 🍵 🍜 🍚 🍺 🍻 🍰 🎮 🎧 🎵 📚 ✏️ 💼 ✈️ 🏖️ 🚗 🎉 🎁 🏆 ⚽".split(" ") },
];

function EmojiPicker({ value, onPick, onClose, T, accent }) {
  return (
    <div className="fixed inset-0 z-[55] flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div onClick={(e) => e.stopPropagation()}
        className={`relative w-full sm:max-w-md ${T.card} rounded-t-3xl sm:rounded-3xl border ${T.border} max-h-[70vh] flex flex-col`}>
        <div className={`flex items-center justify-between px-4 py-3 border-b ${T.border}`}>
          <span className={`text-sm font-semibold ${T.text}`}>기분 이모지 선택</span>
          <div className="flex items-center gap-3">
            {value && (
              <button onClick={() => { onPick(null); onClose(); }}
                className={`text-xs font-medium ${T.sub}`}>선택 해제</button>
            )}
            <button onClick={onClose} className={T.sub}><X size={20} /></button>
          </div>
        </div>
        <div className="overflow-y-auto px-4 py-3 space-y-4">
          {EMOJI_GROUPS.map((g) => (
            <div key={g.name}>
              <div className={`text-[11px] font-bold mb-1.5 ${T.sub}`}>{g.name}</div>
              <div className="grid grid-cols-8 gap-1">
                {g.items.map((em) => {
                  const on = value === em;
                  return (
                    <button key={em} onClick={() => { onPick(em); onClose(); }}
                      className="aspect-square rounded-lg flex items-center justify-center text-2xl"
                      style={on ? { backgroundColor: accent + "24", boxShadow: `inset 0 0 0 2px ${accent}` } : undefined}>
                      {em}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- 사진 편집기 (자유 크롭·회전·색감) ---------- */
const ASPECTS = [
  { id: "free", label: "자유", r: null },
  { id: "1:1", label: "1:1", r: 1 },
  { id: "4:3", label: "4:3", r: 4 / 3 },
  { id: "3:4", label: "3:4", r: 3 / 4 },
  { id: "16:9", label: "16:9", r: 16 / 9 },
];
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const MIN_CROP = 0.1;

function PhotoEditor({ img, onCancel, onApply }) {
  const { T, accent } = useDiary();
  const [baseUrl, setBaseUrl] = useState(null);   // 원본(objectURL/dataURL)
  const [baseBlob, setBaseBlob] = useState(null);
  const [rot, setRot] = useState(0);              // 0/90/180/270
  const [workUrl, setWorkUrl] = useState(null);   // 회전 반영된 표시용
  const [nat, setNat] = useState(null);           // {w,h} workUrl 원본 크기
  const [crop, setCrop] = useState({ x: 0, y: 0, w: 1, h: 1 });
  const [bri, setBri] = useState(100);
  const [con, setCon] = useState(100);
  const [sat, setSat] = useState(100);
  const [busy, setBusy] = useState(false);

  const stageRef = useRef(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const drag = useRef(null);

  /* 원본 로드 */
  useEffect(() => {
    let revoke = null;
    (async () => {
      let blob = img.file;
      if (!blob && img.preview) blob = await (await fetch(img.preview)).blob();
      setBaseBlob(blob);
      const u = URL.createObjectURL(blob);
      revoke = u;
      setBaseUrl(u);
    })();
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [img]);

  /* 회전 반영된 workUrl 생성 (회전 0이면 원본 그대로) */
  useEffect(() => {
    if (!baseBlob || !baseUrl) return;
    let alive = true;
    let revoke = null;
    (async () => {
      if (rot === 0) { if (alive) setWorkUrl(baseUrl); }
      else {
        const bmp = await createImageBitmap(baseBlob, { imageOrientation: "from-image" });
        const rotated = rot % 180 !== 0;
        const c = document.createElement("canvas");
        c.width = rotated ? bmp.height : bmp.width;
        c.height = rotated ? bmp.width : bmp.height;
        const ctx = c.getContext("2d");
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
        bmp.close?.();
        const b = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.95));
        const u = URL.createObjectURL(b);
        revoke = u;
        if (alive) setWorkUrl(u);
      }
      if (alive) setCrop({ x: 0, y: 0, w: 1, h: 1 });
    })();
    return () => { alive = false; if (revoke) URL.revokeObjectURL(revoke); };
  }, [rot, baseBlob, baseUrl]);

  /* workUrl 자연 크기 측정 */
  useEffect(() => {
    if (!workUrl) return;
    const im = new Image();
    im.onload = () => setNat({ w: im.naturalWidth, h: im.naturalHeight });
    im.src = workUrl;
  }, [workUrl]);

  /* 스테이지 크기 추적 */
  useEffect(() => {
    if (!stageRef.current) return;
    const el = stageRef.current;
    const update = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [workUrl]);

  /* 표시 이미지 사각형(스테이지 내 letterbox) */
  const disp = useMemo(() => {
    if (!nat || !stage.w || !stage.h) return null;
    const scale = Math.min(stage.w / nat.w, stage.h / nat.h);
    const w = nat.w * scale, h = nat.h * scale;
    return { x: (stage.w - w) / 2, y: (stage.h - h) / 2, w, h };
  }, [nat, stage]);

  const filterCss = `brightness(${bri}%) contrast(${con}%) saturate(${sat}%)`;

  /* 종횡비 프리셋 → 중앙 정렬 크롭 박스 */
  const applyAspect = (r) => {
    if (!nat) return;
    if (r == null) { setCrop({ x: 0, y: 0, w: 1, h: 1 }); return; }
    // 목표 픽셀 비율 r = W/H. 정규화 좌표로 변환
    let wN = 1, hN = 1;
    // 이미지에 맞게 최대 크기로
    const imgR = nat.w / nat.h;
    if (r >= imgR) { wN = 1; hN = (nat.w / r) / nat.h; }
    else { hN = 1; wN = (nat.h * r) / nat.w; }
    setCrop({ x: (1 - wN) / 2, y: (1 - hN) / 2, w: wN, h: hN });
  };

  /* 포인터 → 정규화 좌표 */
  const toNorm = (e) => {
    const rect = stageRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left - (disp?.x || 0);
    const py = e.clientY - rect.top - (disp?.y || 0);
    return { nx: clamp01(px / (disp?.w || 1)), ny: clamp01(py / (disp?.h || 1)) };
  };

  const onDown = (mode) => (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const { nx, ny } = toNorm(e);
    drag.current = { mode, startNX: nx, startNY: ny, start: { ...crop } };
  };
  const onMove = (e) => {
    if (!drag.current) return;
    const { nx, ny } = toNorm(e);
    const d = drag.current;
    const dx = nx - d.startNX, dy = ny - d.startNY;
    let { x, y, w, h } = d.start;
    const m = d.mode;
    if (m === "move") {
      x = clamp01(x + dx > 0 ? Math.min(x + dx, 1 - w) : 0);
      y = clamp01(y + dy > 0 ? Math.min(y + dy, 1 - h) : 0);
    } else {
      let x1 = x, y1 = y, x2 = x + w, y2 = y + h;
      if (m.includes("w")) x1 = clamp01(Math.min(x + dx, x2 - MIN_CROP));
      if (m.includes("e")) x2 = clamp01(Math.max(x + w + dx, x1 + MIN_CROP));
      if (m.includes("n")) y1 = clamp01(Math.min(y + dy, y2 - MIN_CROP));
      if (m.includes("s")) y2 = clamp01(Math.max(y + h + dy, y1 + MIN_CROP));
      x = x1; y = y1; w = x2 - x1; h = y2 - y1;
    }
    setCrop({ x, y, w, h });
  };
  const onUp = () => { drag.current = null; };

  const apply = async () => {
    setBusy(true);
    try {
      const src = workUrl;
      const blob = await (await fetch(src)).blob();
      const bmp = await createImageBitmap(blob);
      const sx = Math.round(crop.x * bmp.width);
      const sy = Math.round(crop.y * bmp.height);
      const sw = Math.max(1, Math.round(crop.w * bmp.width));
      const sh = Math.max(1, Math.round(crop.h * bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = sw; canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if ("filter" in ctx) ctx.filter = filterCss;
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
      bmp.close?.();
      const out = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.92));
      if (!out) throw new Error("변환 실패");
      const baseName = (img.file?.name || "photo").replace(/\.\w+$/, "");
      const file = new File([out], `${baseName}_edited.jpg`, { type: "image/jpeg" });
      const preview = await new Promise((res) => {
        const r = new FileReader(); r.onload = (e) => res(e.target.result); r.readAsDataURL(out);
      });
      onApply({ type: "photo", preview, file });
    } catch (e) {
      console.error("편집 실패:", e);
      alert("사진 편집에 실패했어요");
    } finally { setBusy(false); }
  };

  const Slider = ({ label, value, set, icon }) => (
    <label className="block">
      <div className={`flex items-center justify-between text-[11px] mb-1 ${T.sub}`}>
        <span>{icon} {label}</span><span className="tabular-nums">{value}%</span>
      </div>
      <input type="range" min={50} max={150} value={value}
        onChange={(e) => set(+e.target.value)} className="w-full" style={{ accentColor: accent }} />
    </label>
  );

  const Handle = ({ pos, style }) => (
    <div onPointerDown={onDown(pos)} onPointerMove={onMove} onPointerUp={onUp}
      className="absolute w-6 h-6 -m-3 touch-none" style={style}>
      <div className="w-3.5 h-3.5 m-1.5 rounded-full bg-white border-2" style={{ borderColor: accent }} />
    </div>
  );

  const box = disp && {
    left: disp.x + crop.x * disp.w,
    top: disp.y + crop.y * disp.h,
    width: crop.w * disp.w,
    height: crop.h * disp.h,
  };

  return (
    <div className={`fixed inset-0 z-[60] ${T.bg} overflow-y-auto`}>
      <div className={`sticky top-0 z-10 ${T.card} border-b ${T.border}`}>
        <div className="max-w-md mx-auto flex items-center justify-between px-4 py-3">
          <button onClick={onCancel} disabled={busy} className={`text-sm font-medium ${T.sub}`}>취소</button>
          <span className={`font-semibold text-sm ${T.text}`}>사진 편집</span>
          <button onClick={apply} disabled={busy}
            className="flex items-center gap-1 font-semibold text-sm disabled:opacity-40" style={{ color: accent }}>
            {busy && <Loader2 size={14} className="animate-spin" />}{busy ? "적용 중" : "적용"}
          </button>
        </div>
      </div>

      <div className="max-w-md mx-auto p-4 space-y-4">
        {/* 크롭 스테이지 */}
        <div ref={stageRef} className="relative w-full bg-black/90 rounded-2xl overflow-hidden select-none"
          style={{ height: "46vh" }}>
          {workUrl && (
            <img src={workUrl} alt="편집" draggable={false}
              className="absolute inset-0 w-full h-full object-contain pointer-events-none"
              style={{ filter: filterCss }} />
          )}
          {box && (
            <>
              {/* 바깥 어둡게 + 크롭 테두리 */}
              <div onPointerDown={onDown("move")} onPointerMove={onMove} onPointerUp={onUp}
                className="absolute touch-none"
                style={{
                  left: box.left, top: box.top, width: box.width, height: box.height,
                  boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)", outline: `1.5px solid ${accent}`,
                }}>
                {/* 3분할 안내선 */}
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute top-1/3 inset-x-0 border-t border-white/30" />
                  <div className="absolute top-2/3 inset-x-0 border-t border-white/30" />
                  <div className="absolute left-1/3 inset-y-0 border-l border-white/30" />
                  <div className="absolute left-2/3 inset-y-0 border-l border-white/30" />
                </div>
              </div>
              <Handle pos="nw" style={{ left: box.left, top: box.top }} />
              <Handle pos="ne" style={{ left: box.left + box.width, top: box.top }} />
              <Handle pos="sw" style={{ left: box.left, top: box.top + box.height }} />
              <Handle pos="se" style={{ left: box.left + box.width, top: box.top + box.height }} />
            </>
          )}
        </div>

        {/* 회전 · 종횡비 */}
        <div className="flex items-center gap-2">
          <button onClick={() => setRot((r) => (r + 270) % 360)}
            className={`flex items-center gap-1 px-3 py-2 rounded-xl ${T.input} ${T.text} text-xs`}>
            <RotateCcw size={15} />
          </button>
          <button onClick={() => setRot((r) => (r + 90) % 360)}
            className={`flex items-center gap-1 px-3 py-2 rounded-xl ${T.input} ${T.text} text-xs`}>
            <RotateCw size={15} />
          </button>
          <div className="flex-1 flex gap-1.5 overflow-x-auto no-scrollbar">
            {ASPECTS.map((a) => (
              <button key={a.id} onClick={() => applyAspect(a.r)}
                className={`flex-shrink-0 px-3 py-2 rounded-xl text-xs font-medium ${T.input} ${T.text}`}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
        <p className={`text-[11px] ${T.sub} flex items-center gap-1`}>
          <Crop size={11} /> 모서리를 끌어 크기를 자유롭게 조정하고, 안쪽을 끌어 위치를 옮기세요
        </p>

        {/* 색감 */}
        <div className={`rounded-2xl ${T.card} border ${T.border} p-4 space-y-3`}>
          <div className={`flex items-center gap-1.5 text-[11px] font-bold ${T.sub}`}>
            <SlidersHorizontal size={12} /> 색감 조정
          </div>
          <Slider label="밝기" value={bri} set={setBri} icon="☀️" />
          <Slider label="대비" value={con} set={setCon} icon="◑" />
          <Slider label="채도" value={sat} set={setSat} icon="🎨" />
        </div>
      </div>
    </div>
  );
}

/* ---------- 작성 / 편집 전체 페이지 ---------- */
function WritePage({ initial, onClose }) {
  const { T, accent, addEntry, updateEntry } = useDiary();
  const editing = !!initial?.id;
  const [date, setDate] = useState(initial?.date || todayStr());
  const [text, setText] = useState(initial?.text || "");
  const [location, setLocation] = useState(initial?.location || "");
  const [mood, setMood] = useState(initial?.mood || null);
  const [images, setImages] = useState(initial?.images || []);
  const [gratitude, setGratitude] = useState(initial?.gratitude || "");
  const [regret, setRegret] = useState(initial?.regret || "");
  const [body, setBody] = useState(initial?.body || "");
  const [mind, setMind] = useState(initial?.mind || "");
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [autoLoc, setAutoLoc] = useState(false);
  const [autoFilled, setAutoFilled] = useState(false);
  const [locError, setLocError] = useState(null);
  const [locNote, setLocNote] = useState(null);
  const [editIdx, setEditIdx] = useState(null);
  const [pickMood, setPickMood] = useState(false);
  const fileRef = useRef(null);
  const tags = extractTags(text);

  const hasContent =
    text.trim() || images.length > 0 || gratitude.trim() ||
    regret.trim() || body.trim() || mind.trim() || mood;

  const fillCurrentLocation = async () => {
    setLocError(null); setLocNote(null); setLocating(true);
    try { setLocation(await getCurrentPlace()); setAutoFilled(false); }
    catch (e) { setLocError(e.message); }
    finally { setLocating(false); }
  };

  const tryAutoLocation = async (files) => {
    if (location.trim() || files.length === 0) return;
    setAutoLoc(true); setLocNote(null); setLocError(null);
    try {
      let found = false;
      for (const f of files) {
        const place = await getPlaceFromFile(f).catch(() => null);
        if (place) { setLocation((cur) => (cur.trim() ? cur : place)); setAutoFilled(true); found = true; break; }
      }
      if (!found) setLocNote("사진에 위치 정보가 없어요 · 아이콘을 눌러 현재 위치를 넣거나 직접 입력하세요");
    } finally { setAutoLoc(false); }
  };

  const addPhotos = (files) => {
    const arr = [...files].slice(0, 5 - images.length);
    arr.forEach((f) => {
      const r = new FileReader();
      r.onload = (ev) => setImages((imgs) =>
        imgs.length < 5 ? [...imgs, { type: "photo", preview: ev.target.result, file: f }] : imgs);
      r.readAsDataURL(f);
    });
    tryAutoLocation(arr.filter((f) => f instanceof Blob));
  };

  const save = async () => {
    if (!hasContent || saving) return;
    setSaving(true);
    try {
      const data = {
        date, text: text.trim(), location: location.trim(), mood, images,
        gratitude: gratitude.trim(), regret: regret.trim(),
        body: body.trim(), mind: mind.trim(),
      };
      if (editing) await updateEntry({ ...initial, ...data });
      else await addEntry(data);
      onClose();
    } catch (e) {
      console.error("저장 실패:", e);
      alert(`저장에 실패했어요: ${e.message}`);
    } finally { setSaving(false); }
  };

  const inputCls = `w-full ${T.input} rounded-xl p-3 text-sm outline-none resize-none ${T.text}`;

  return (
    <div className={`fixed inset-0 z-50 ${T.bg} overflow-y-auto`}>
      <div className={`sticky top-0 z-10 ${T.card} border-b ${T.border}`}>
        <div className="max-w-md mx-auto flex items-center justify-between px-4 py-3">
          <button onClick={onClose} disabled={saving} className={T.sub}><X size={22} /></button>
          <span className={`font-semibold text-sm ${T.text}`}>{editing ? "일기 수정" : "새 일기"}</span>
          <button onClick={save} disabled={!hasContent || saving}
            className="flex items-center gap-1 font-semibold text-sm disabled:opacity-40" style={{ color: accent }}>
            {saving && <Loader2 size={14} className="animate-spin" />}{saving ? "저장 중" : "저장"}
          </button>
        </div>
      </div>

      <div className="max-w-md mx-auto">
        <div className="p-4 pb-16">
          {/* 하나의 카드 안에 세 섹션 */}
          <div className={`rounded-2xl border ${T.border} ${T.card} p-4 space-y-5`}>

            {/* ===== 하이라이트 ===== */}
            <div className="space-y-3">
              <SectionTitle icon={Sparkles} title="하이라이트" accent={accent} T={T} />

              {/* 사진: 없으면 중앙 추가 버튼 / 있으면 가로 꽉 찬 이미지 */}
              <div className="space-y-2">
                {images.map((img, i) => {
                  const editable = !!(img.file || img.preview);
                  return (
                    <div key={i} className="relative w-full rounded-xl overflow-hidden">
                      {img.preview
                        ? <img src={img.preview} alt="사진" className="w-full h-auto block" />
                        : <div className="aspect-[4/3]"><Img img={img} /></div>}
                      <button onClick={() => setImages(images.filter((_, j) => j !== i))}
                        className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 flex items-center justify-center">
                        <X size={14} className="text-white" />
                      </button>
                      {editable && (
                        <button onClick={() => setEditIdx(i)}
                          className="absolute bottom-2 right-2 flex items-center gap-1 px-2.5 h-7 rounded-full bg-black/60 text-white text-xs">
                          <Pencil size={12} /> 편집
                        </button>
                      )}
                    </div>
                  );
                })}
                {images.length < 5 && (
                  <button onClick={() => fileRef.current?.click()}
                    className={`w-full ${images.length === 0 ? "aspect-[16/10]" : "py-4"} rounded-xl border-2 border-dashed ${T.border} flex flex-col items-center justify-center gap-2 ${T.sub} hover:opacity-70`}>
                    <ImageIcon size={images.length === 0 ? 30 : 22} />
                    <span className="text-xs font-medium">사진 추가 ({images.length}/5)</span>
                  </button>
                )}
                <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
                  onChange={(e) => { addPhotos(e.target.files); e.target.value = ""; }} />
              </div>

              {/* 날짜 + 위치 */}
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className={`text-xs font-medium ${T.sub}`}>날짜</span>
                  <input type="date" value={date} max={todayStr()}
                    onChange={(e) => setDate(e.target.value)}
                    className={`mt-1 w-full ${T.input} rounded-xl px-3 py-2 text-sm outline-none ${T.text}`} />
                </label>
                <label className="block">
                  <span className={`text-xs font-medium ${T.sub}`}>위치</span>
                  <div className={`mt-1 flex items-center gap-1.5 ${T.input} rounded-xl px-3 py-2`}>
                    <MapPin size={14} className={T.sub} />
                    <input value={location}
                      onChange={(e) => { setLocation(e.target.value); setAutoFilled(false); setLocNote(null); }}
                      placeholder={autoLoc ? "사진 위치 확인 중…" : "장소 추가"}
                      className={`flex-1 min-w-0 bg-transparent text-sm outline-none ${T.text}`} />
                    <button type="button" onClick={fillCurrentLocation} disabled={locating}
                      title="현재 위치 자동 입력" className="flex-shrink-0 disabled:opacity-50">
                      <LocateFixed size={15} style={locating || autoLoc ? { color: accent } : undefined}
                        className={locating || autoLoc ? "animate-pulse" : T.sub} />
                    </button>
                  </div>
                </label>
              </div>
              {autoFilled && !locError && (
                <p className="text-xs flex items-center gap-1" style={{ color: accent }}>
                  <MapPin size={11} /> 사진의 위치 정보로 자동 입력했어요 · 필요하면 수정하세요
                </p>
              )}
              {locNote && !locError && <p className={`text-xs ${T.sub}`}>{locNote}</p>}
              {locError && <p className="text-xs text-red-500">{locError}</p>}

              {/* 내용 */}
              <div>
                <span className={`text-xs font-medium ${T.sub}`}>내용</span>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5}
                  placeholder={"오늘 하루는 어땠나요?\n#해시태그 를 붙이면 모아볼 수 있어요"}
                  className={`mt-1 ${inputCls}`} />
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {tags.map((t) => (
                      <span key={t} className="text-xs px-2 py-0.5 rounded-full font-medium"
                        style={{ backgroundColor: accent + "1a", color: accent }}>#{t}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className={`border-t ${T.border}`} />

            {/* ===== 오늘의 배움 ===== */}
            <div className="space-y-3">
              <SectionTitle icon={BookOpen} title="오늘의 배움" accent={accent} T={T} />
              <div>
                <span className={`text-xs font-medium ${T.sub}`}>감사</span>
                <textarea value={gratitude} onChange={(e) => setGratitude(e.target.value)} rows={2}
                  placeholder="오늘 감사했던 순간은?" className={`mt-1 ${inputCls}`} />
              </div>
              <div>
                <span className={`text-xs font-medium ${T.sub}`}>아쉬움</span>
                <textarea value={regret} onChange={(e) => setRegret(e.target.value)} rows={2}
                  placeholder="다음엔 이렇게 해보고 싶어요" className={`mt-1 ${inputCls}`} />
              </div>
            </div>

            <div className={`border-t ${T.border}`} />

            {/* ===== 오늘의 건강 ===== */}
            <div className="space-y-3">
              <SectionTitle icon={HeartPulse} title="오늘의 건강" accent={accent} T={T} />
              {/* 마음: [+ 이모지] + 입력창 */}
              <div>
                <span className={`text-xs font-medium ${T.sub}`}>마음</span>
                <div className="mt-1 flex items-stretch gap-2">
                  <button type="button" onClick={() => setPickMood(true)}
                    className="w-12 flex-shrink-0 rounded-xl flex items-center justify-center text-2xl"
                    style={{
                      backgroundColor: mood ? accent + "24" : (T.input.includes("#26272c") ? "#26272c" : "#eef0f3"),
                      boxShadow: mood ? `inset 0 0 0 2px ${accent}` : "none",
                    }}
                    title="기분 이모지 선택">
                    {mood ? mood : <Plus size={20} className={T.sub} />}
                  </button>
                  <input value={mind} onChange={(e) => setMind(e.target.value)}
                    placeholder="마음은 어땠나요?"
                    className={`flex-1 min-w-0 ${T.input} rounded-xl px-3 text-sm outline-none ${T.text}`} />
                </div>
              </div>
              {/* 몸 */}
              <div>
                <span className={`text-xs font-medium ${T.sub}`}>몸</span>
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2}
                  placeholder="수면·운동·식사·컨디션 등" className={`mt-1 ${inputCls}`} />
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* 이모지 선택 */}
      {pickMood && (
        <EmojiPicker value={mood} onPick={setMood} onClose={() => setPickMood(false)} T={T} accent={accent} />
      )}

      {/* 사진 편집기 */}
      {editIdx != null && images[editIdx] && (
        <PhotoEditor
          img={images[editIdx]}
          onCancel={() => setEditIdx(null)}
          onApply={(newImg) => {
            setImages((imgs) => imgs.map((im, j) => (j === editIdx ? newImg : im)));
            setEditIdx(null);
          }}
        />
      )}
    </div>
  );
}

/* ---------- 상세 모달 (하루/단일 일기) ---------- */
function DetailModal({ detail, onClose }) {
  const { T, entries } = useDiary();
  const list = useMemo(() => {
    if (detail.mode === "entry") { const e = entries.find((x) => x.id === detail.key); return e ? [e] : []; }
    return entries.filter((e) => e.date === detail.key).sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  }, [detail, entries]);

  useEffect(() => { if (list.length === 0) onClose(); }, [list, onClose]);
  if (list.length === 0) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-start sm:items-center justify-center bg-black/70 overflow-y-auto" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md p-3 sm:p-6 space-y-4 my-auto">
        <div className="flex items-center justify-between text-white">
          <span className="text-sm font-semibold">{fmtDate(list[0].date)}{list.length > 1 && ` · ${list.length}개`}</span>
          <button onClick={onClose} className="text-white/80 hover:text-white"><X size={24} /></button>
        </div>
        {list.map((e) => <DiaryCard key={e.id} entry={e} />)}
      </div>
    </div>
  );
}

/* ---------- 설정 모달 ---------- */
function SettingsModal({ onClose }) {
  const { T, accent, dark, setDark, user } = useDiary();
  const importRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState(null);
  const [backfillResult, setBackfillResult] = useState(null);

  const handleBackfill = async () => {
    if (backfilling) return;
    setBackfilling(true); setBackfillResult(null); setBackfillProgress(null);
    try {
      const { backfillPhotos } = await migrateMod();
      const n = await backfillPhotos(user.uid, (done, total) => setBackfillProgress({ done, total }));
      setBackfillResult(n === 0 ? "✅ 이미 모두 최적화되어 있어요" : `✅ 사진 ${n}장 최적화 완료`);
    } catch (e) {
      console.error("최적화 실패:", e);
      setBackfillResult(`최적화 실패: ${e.message}`);
    } finally { setBackfilling(false); setBackfillProgress(null); }
  };

  const Section = ({ title, children }) => (
    <div className={`border-b ${T.border} pb-5 mb-5 last:border-0 last:pb-0 last:mb-0`}>
      <div className={`text-[11px] font-semibold tracking-wider mb-3 ${T.sub}`}>{title}</div>
      {children}
    </div>
  );

  const handleImport = async (file) => {
    if (!file || importing) return;
    setImporting(true); setImportResult(null); setImportProgress(null);
    try {
      const json = JSON.parse(await file.text());
      const total = Array.isArray(json) ? json.length : 0;
      if (total && !window.confirm(
        `${total}건의 일기를 가져옵니다. 같은 파일을 두 번 가져오면 중복 생성돼요. 계속할까요?`)) {
        setImporting(false); return;
      }
      const { importLegacyJSON } = await migrateMod();
      const n = await importLegacyJSON(user.uid, json, (done, t) => setImportProgress({ done, total: t }));
      setImportResult(`✅ ${n}건 가져오기 완료`);
    } catch (e) {
      console.error("가져오기 실패:", e);
      setImportResult(`가져오기 실패: ${e.message}`);
    } finally { setImporting(false); setImportProgress(null); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className={`${T.card} w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col overflow-hidden`}>
        <div className={`flex items-center justify-between px-4 py-3 border-b ${T.border}`}>
          <button onClick={onClose} className={T.sub}><X size={22} /></button>
          <span className={`font-semibold text-sm ${T.text}`}>설정</span>
          <span className="w-[22px]" />
        </div>

        <div className="overflow-y-auto p-4">
          <Section title="계정">
            <div className="flex items-center gap-3">
              {user.photoURL ? (
                <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="w-9 h-9 rounded-full" />
              ) : (
                <div className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm text-white" style={{ backgroundColor: accent }}>
                  {(user.email || "U")[0].toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium truncate ${T.text}`}>{user.email}</div>
                <div className={`text-xs ${T.sub}`}>실시간 동기화 중 · Cloud Firestore</div>
              </div>
              <button onClick={() => logOut().catch(console.error)}
                className="flex items-center gap-1 text-xs text-red-500 hover:opacity-70">
                <LogOut size={13} /> 로그아웃
              </button>
            </div>
          </Section>

          <Section title="데이터">
            <div className="space-y-3">
              <div>
                <div className={`text-sm ${T.text}`}>기존 백업 가져오기</div>
                <div className={`text-xs ${T.sub}`}>
                  이전 Drive 백업 파일(lifelog-backup-*.json)을 Firestore로 옮깁니다. 1회만 실행하세요.
                </div>
              </div>
              <button onClick={() => importRef.current?.click()} disabled={importing}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-white text-sm font-medium disabled:opacity-40"
                style={{ backgroundColor: accent }}>
                {importing ? <Loader2 size={15} className="animate-spin" /> : <UploadCloud size={15} />}
                {importing ? (importProgress ? `가져오는 중... ${importProgress.done}/${importProgress.total}` : "가져오는 중...") : "JSON 파일 선택"}
              </button>
              <input ref={importRef} type="file" accept="application/json,.json" className="hidden"
                onChange={(e) => { handleImport(e.target.files[0]); e.target.value = ""; }} />
              {importResult && (
                <div className={`text-xs flex items-center gap-1 ${importResult.startsWith("✅") ? "text-emerald-600" : "text-red-500"}`}>
                  {importResult.startsWith("✅") && <Check size={13} />}{importResult}
                </div>
              )}

              <div className={`pt-3 mt-1 border-t ${T.border} space-y-3`}>
                <div>
                  <div className={`text-sm ${T.text}`}>이미지 로딩 최적화</div>
                  <div className={`text-xs ${T.sub}`}>
                    기존 사진의 썸네일을 만들어 목록 로딩을 크게 빠르게 합니다. 사진이 많으면 시간이 걸릴 수 있어요. 1회만 실행하면 됩니다.
                  </div>
                </div>
                <button onClick={handleBackfill} disabled={backfilling}
                  className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium border ${T.border} ${T.text} disabled:opacity-40 hover:opacity-80`}>
                  {backfilling ? <Loader2 size={15} className="animate-spin" /> : <ImageIcon size={15} />}
                  {backfilling
                    ? (backfillProgress ? `최적화 중... ${backfillProgress.done}/${backfillProgress.total}` : "최적화 중...")
                    : "지금 최적화"}
                </button>
                {backfillResult && (
                  <div className={`text-xs flex items-center gap-1 ${backfillResult.startsWith("✅") ? "text-emerald-600" : "text-red-500"}`}>
                    {backfillResult.startsWith("✅") && <Check size={13} />}{backfillResult}
                  </div>
                )}
              </div>
            </div>
          </Section>

          <Section title="테마">
            <div className="flex gap-2">
              {[{ v: false, icon: Sun, label: "라이트" }, { v: true, icon: Moon, label: "다크" }].map(({ v, icon: Icon, label }) => {
                const on = dark === v;
                return (
                  <button key={label} onClick={() => setDark(v)}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-medium border transition-colors ${on ? "text-white border-transparent" : `${T.card} ${T.text} ${T.border} hover:opacity-70`}`}
                    style={on ? { backgroundColor: accent } : undefined}>
                    <Icon size={15} /> {label}
                  </button>
                );
              })}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

/* ---------- 프로필 뷰 ---------- */
function ProfileView() {
  const { T, accent, user, uname, entries, dark, setDark, openPhotoWall, openSettings } = useDiary();
  const stats = useMemo(() => ({
    logs: entries.length,
    tags: new Set(entries.flatMap((e) => extractTags(e.text))).size,
    months: new Set(entries.map((e) => e.date.slice(0, 7))).size,
    scraps: entries.filter((e) => e.scrapped).length,
  }), [entries]);

  const Stat = ({ n, label }) => (
    <div className="text-center">
      <div className={`text-lg font-bold ${T.text}`}>{n}</div>
      <div className={`text-[11px] ${T.sub}`}>{label}</div>
    </div>
  );

  return (
    <div className="max-w-md mx-auto px-4 pt-5 pb-4 space-y-5">
      {/* 계정 헤더 */}
      <div className={`${T.card} border ${T.border} rounded-2xl p-4`}>
        <div className="flex items-center gap-3">
          {user.photoURL ? (
            <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="w-12 h-12 rounded-full" />
          ) : (
            <div className="w-12 h-12 rounded-full flex items-center justify-center font-bold text-white" style={{ backgroundColor: accent }}>
              {(user.email || "U")[0].toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-semibold ${T.text} truncate`}>{uname}</div>
            <div className={`text-xs ${T.sub} truncate`}>{user.email}</div>
          </div>
          <button onClick={openSettings} className={`p-2 rounded-full hover:bg-neutral-500/10 ${T.icon}`}>
            <Settings size={18} strokeWidth={1.8} />
          </button>
        </div>
        <div className={`grid grid-cols-4 gap-2 mt-4 pt-4 border-t ${T.border}`}>
          <Stat n={stats.logs} label="일기" />
          <Stat n={stats.tags} label="태그" />
          <Stat n={stats.months} label="개월" />
          <Stat n={stats.scraps} label="스크랩" />
        </div>
      </div>

      {/* 바로가기 */}
      <div className="grid grid-cols-2 gap-3">
        <button onClick={openPhotoWall}
          className={`${T.card} border ${T.border} rounded-2xl p-4 flex flex-col items-start gap-2 hover:opacity-80`}>
          <LayoutGrid size={20} style={{ color: accent }} />
          <span className={`text-sm font-semibold ${T.text}`}>사진 모아보기</span>
          <span className={`text-xs ${T.sub}`}>전체 사진 모자이크</span>
        </button>
        <button onClick={() => setDark(!dark)}
          className={`${T.card} border ${T.border} rounded-2xl p-4 flex flex-col items-start gap-2 hover:opacity-80`}>
          {dark ? <Sun size={20} style={{ color: accent }} /> : <Moon size={20} style={{ color: accent }} />}
          <span className={`text-sm font-semibold ${T.text}`}>{dark ? "라이트 모드" : "다크 모드"}</span>
          <span className={`text-xs ${T.sub}`}>테마 전환</span>
        </button>
      </div>
    </div>
  );
}

/* ---------- 스크랩 뷰 (독립 탭) ---------- */
function ScrapView() {
  const { T, accent, entries, openEntry } = useDiary();
  const scrapped = useMemo(
    () => entries.filter((e) => e.scrapped).sort((a, b) => b.date.localeCompare(a.date)),
    [entries]
  );
  return (
    <div className="max-w-md mx-auto px-3 pt-6 pb-4">
      <div className="px-1 mb-4 flex items-center gap-1.5">
        <Bookmark size={18} style={{ fill: accent, color: accent }} />
        <span className={`text-xl font-bold ${T.text}`}>스크랩</span>
        <span className={`text-sm ${T.sub}`}>{scrapped.length}</span>
      </div>
      {scrapped.length === 0 ? (
        <div className={`text-center py-20 ${T.sub} text-sm`}>
          <Bookmark size={36} className="mx-auto mb-3 opacity-40" />
          일기의 북마크를 눌러 스크랩해보세요
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-[3px]">
          {scrapped.map((e) => (
            <button key={e.id} onClick={() => openEntry(e)} className="relative aspect-square rounded-lg overflow-hidden group">
              <Img img={e.images[0]} thumb />
              <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-transparent" />
              <span className="absolute top-1 left-1.5 text-[11px] font-bold text-white drop-shadow">{+e.date.slice(8)}</span>
              {e.images.length > 1 && <Layers size={13} className="absolute top-1 right-1 text-white drop-shadow" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- 하단 네비게이션 ---------- */
function BottomNav({ onWrite }) {
  const { T, accent, view, setView } = useDiary();
  const Item = ({ id, icon: Icon }) => {
    const on = view === id;
    return (
      <button onClick={() => setView(id)} className="flex-1 flex flex-col items-center justify-center py-3 gap-1">
        <Icon size={23} strokeWidth={on ? 2.3 : 1.8} style={on ? { color: accent } : undefined} className={on ? "" : T.sub} />
        <span className="w-1 h-1 rounded-full" style={{ backgroundColor: on ? accent : "transparent" }} />
      </button>
    );
  };
  return (
    <nav className={`fixed bottom-0 inset-x-0 ${T.card} border-t ${T.border} z-30`}>
      <div className="max-w-md mx-auto flex items-center">
        <Item id="home" icon={CalendarIcon} />
        <Item id="scrap" icon={Bookmark} />
        <button onClick={onWrite} className="flex-1 flex items-center justify-center py-2">
          <span className="w-12 h-12 rounded-full flex items-center justify-center shadow-lg hover:scale-105 transition-transform"
            style={{ backgroundColor: accent }}>
            <Plus size={24} className="text-white" />
          </span>
        </button>
        <Item id="report" icon={BarChart3} />
        <Item id="profile" icon={User} />
      </div>
    </nav>
  );
}

/* ---------- 로그인 화면 ---------- */
function LoginScreen({ T }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const accent = accentOf(new Date().getMonth());
  const login = async () => {
    setBusy(true); setError(null);
    try { await signInWithGoogle(); }
    catch (e) {
      console.error("로그인 실패:", e);
      if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request")
        setError("로그인에 실패했어요. 잠시 후 다시 시도해주세요");
    } finally { setBusy(false); }
  };
  return (
    <div className={`min-h-screen ${T.bg} flex flex-col items-center justify-center px-8`}>
      <div className="font-display text-7xl leading-none mb-1" style={{ color: accent }}>LIFELOG</div>
      <p className={`text-sm mb-10 ${T.sub}`}>하루를 사진으로 기록하는 다이어리</p>
      <button onClick={login} disabled={busy}
        className={`w-full max-w-xs flex items-center justify-center gap-2 py-3 rounded-2xl border ${T.border} ${T.card} text-sm font-medium ${T.text} hover:opacity-80 disabled:opacity-40`}>
        {busy ? <Loader2 size={16} className="animate-spin" />
          : <span className="font-bold bg-gradient-to-r from-blue-500 via-red-500 to-amber-500 bg-clip-text text-transparent">G</span>}
        Google 계정으로 시작하기
      </button>
      {error && <p className="mt-4 text-xs text-red-500">{error}</p>}
    </div>
  );
}

/* ---------- Firebase 설정 안내 화면 ---------- */
function SetupNotice({ T }) {
  return (
    <div className={`min-h-screen ${T.bg} flex flex-col items-center justify-center px-8 text-center`}>
      <h1 className={`text-2xl font-bold mb-3 ${T.text}`}>Firebase 설정이 필요해요</h1>
      <p className={`text-sm ${T.sub} leading-relaxed`}>
        <code>src/firebase-config.js</code>에 Firebase 콘솔의<br />
        웹 앱 설정(firebaseConfig)을 붙여넣어주세요.<br />
        자세한 순서는 <code>FIREBASE_SETUP.md</code>를 참고하세요.
      </p>
    </div>
  );
}

/* ================================================================
   App (루트)
   ================================================================ */

/* 마지막으로 로그인했던 uid.
   Firebase Auth의 첫 onAuthStateChanged는 저장된 세션을 읽고 필요하면
   토큰을 갱신(securetoken.googleapis.com 왕복)하기 때문에 200~500ms가
   걸립니다. 예전에는 이걸 다 기다린 뒤에야 Firestore 구독을 시작해서
   그 시간만큼 화면이 스피너였습니다.
   Firestore 영속 캐시는 토큰 없이도 로컬 데이터를 바로 내어 주므로,
   마지막 uid를 기억해 두고 인증과 **병렬로** 구독을 시작합니다. */
const LAST_UID_KEY = "lifelog-last-uid";
const readBootUid = () => {
  try { return localStorage.getItem(LAST_UID_KEY); } catch { return null; }
};
const writeBootUid = (uid) => {
  try {
    if (uid) localStorage.setItem(LAST_UID_KEY, uid);
    else localStorage.removeItem(LAST_UID_KEY);
  } catch { /* noop */ }
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export default function LifeLogApp() {
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem("lifelog-theme") === "dark"; } catch { return false; }
  });
  const [user, setUser] = useState(undefined);
  const [bootUid] = useState(readBootUid); // 부팅 시점 1회만 읽음
  const [entries, setEntries] = useState([]);
  const [view, setView] = useState("home"); // home | scrap | report | profile
  const [month, setMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [filter, setFilter] = useState({ mood: null, tag: null, query: "" });
  const [writeOpen, setWriteOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [detail, setDetail] = useState(null);     // { mode:'day'|'entry', key }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [photoWallOpen, setPhotoWallOpen] = useState(false);

  useEffect(() => {
    try { localStorage.setItem("lifelog-theme", dark ? "dark" : "light"); } catch { /* noop */ }
  }, [dark]);

  useEffect(() => {
    if (!CONFIG_READY) return;
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      writeBootUid(u ? u.uid : null);
    });
  }, []);

  /* 인증이 아직 안 끝났으면 마지막 uid로 먼저 붙는다(영속 캐시가 즉시 응답).
     인증이 끝나 uid가 같으면 값이 안 바뀌므로 재구독도 없다. */
  const activeUid = user === undefined ? bootUid : user?.uid || null;

  useEffect(() => {
    if (!activeUid) { setEntries([]); return; }
    let alive = true;
    let first = true;

    const unsub = subscribeLogs(
      activeUid,
      (list) => {
        if (!alive) return;
        const keys = listThumbKeys(list);
        if (first) {
          first = false;
          /* 첫 스냅샷만: 썸네일을 IndexedDB에서 한 번에 읽어 두고 그린다.
             → 사진이 스켈레톤 → 이미지로 깜빡이지 않고 처음부터 채워진 채 뜬다.
             로컬 읽기가 느린 기기를 대비해 250ms 상한을 둔다. */
          Promise.race([warmThumbs(keys), delay(250)]).then(() => {
            if (alive) setEntries(list);
          });
        } else {
          setEntries(list);
          warmThumbs(keys);
        }
      },
      (e) => console.error("동기화 오류:", e)
    );
    return () => { alive = false; unsub(); };
  }, [activeUid]);

  /* 테마 토큰 — DayPic 스타일 클린 화이트 (라이트/다크) */
  const T = dark
    ? { bg: "bg-[#111214]", card: "bg-[#1b1c1f]", text: "text-[#f1f1f3]", sub: "text-[#9a9ba1]", border: "border-[#2a2b30]", input: "bg-[#26272c]", icon: "text-[#f1f1f3]" }
    : { bg: "bg-[#f4f5f7]", card: "bg-white", text: "text-[#1a1a1c]", sub: "text-[#8a8f98]", border: "border-[#eceef1]", input: "bg-[#eef0f3]", icon: "text-[#1a1a1c]" };

  const accent = accentOf(month.m);

  /* 인증 확인 전이라도 마지막 uid가 있으면 곧바로 앱 화면을 그린다.
     (스피너 없이 캐시된 일기·사진이 즉시 보이는 구간) */
  const account = user || (user === undefined && bootUid ? { uid: bootUid, email: null } : null);

  if (!CONFIG_READY) return <SetupNotice T={T} />;
  if (!account) {
    if (user === undefined)
      return (
        <div className={`min-h-screen ${T.bg} flex items-center justify-center`}>
          <Loader2 size={28} className={`animate-spin ${T.sub}`} />
        </div>
      );
    return <LoginScreen T={T} />;
  }

  const addEntry = (data) => createLog(account.uid, data);
  const updateEntry = (entry) => {
    const prev = entries.find((e) => e.id === entry.id);
    return updateLog(account.uid, prev?.images || [], entry);
  };
  const deleteEntry = (id) => {
    const entry = entries.find((e) => e.id === id);
    if (entry) deleteLog(account.uid, entry).catch((e) => console.error("삭제 실패:", e));
  };
  const openEdit = (entry) => { setDetail(null); setEditTarget(entry); setWriteOpen(true); };
  const toggleScrap = (id) => {
    const entry = entries.find((e) => e.id === id);
    if (entry) setScrap(account.uid, id, !entry.scrapped).catch((e) => console.error("스크랩 실패:", e));
  };
  const openDay = (list) => setDetail({ mode: "day", key: list[0].date });
  const openEntry = (entry) => setDetail({ mode: "entry", key: entry.id });
  const openSearch = (tag) => { setFilter({ mood: null, tag: tag || null, query: "" }); setSearchOpen(true); };
  const openPhotoWall = () => setPhotoWallOpen(true);
  const openSettings = () => setSettingsOpen(true);

  const monthEntries = entries.filter((e) => e.date.startsWith(`${month.y}-${pad2(month.m + 1)}`));
  const uname = account.email ? account.email.split("@")[0] : "my.diary";

  const ctx = {
    T, dark, setDark, accent, user: account, uname, entries, monthEntries, filter, setFilter,
    view, setView, month, setMonth,
    addEntry, updateEntry, deleteEntry, openEdit, toggleScrap,
    openDay, openEntry, openSearch, openPhotoWall, openSettings,
  };

  const showHeader = view === "home";

  return (
    <DiaryContext.Provider value={ctx}>
      <div className={`min-h-screen ${T.bg} transition-colors`}>
        <main className="max-w-md mx-auto pb-28">
          {showHeader && (
            <MonthHeader
              right={
                <button onClick={() => setSearchOpen(true)} className={`p-2 rounded-full hover:bg-neutral-500/10 ${T.icon}`}><Search size={20} strokeWidth={1.9} /></button>
              }
            />
          )}
          {view === "home" && <HomeView />}
          {view === "scrap" && <ScrapView />}
          {view === "report" && <ReportView />}
          {view === "profile" && <ProfileView />}
        </main>

        <BottomNav onWrite={() => { setEditTarget(null); setWriteOpen(true); }} />

        {writeOpen && <WritePage initial={editTarget} onClose={() => setWriteOpen(false)} />}
        {detail && <DetailModal detail={detail} onClose={() => setDetail(null)} />}
        {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} />}
        {photoWallOpen && <PhotoWallModal onClose={() => setPhotoWallOpen(false)} />}
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      </div>
    </DiaryContext.Provider>
  );
}
