import React, { useState, useMemo, useRef, useEffect, createContext, useContext } from "react";
import {
  Calendar as CalendarIcon, LayoutGrid, Plus, BarChart3, User,
  Search, Settings, X, ChevronLeft, ChevronRight, ChevronDown,
  MapPin, LocateFixed, Trash2, Pencil, Bookmark, MoreHorizontal,
  Image as ImageIcon, Layers, Palette, Hash, Moon, Sun,
  LogOut, Loader2, Check, UploadCloud, Rows,
} from "lucide-react";
import { auth, CONFIG_READY, signInWithGoogle, logOut } from "./firebase";
import { onAuthStateChanged } from "firebase/auth";
import { subscribeLogs, createLog, updateLog, deleteLog, setScrap } from "./db";
import { getPhotoURL } from "./photos";
import { importLegacyJSON } from "./migrate";

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
const MOODS = [
  { id: "sunny", label: "맑음", emoji: "☀️" },
  { id: "cloudy", label: "흐림", emoji: "☁️" },
  { id: "happy", label: "행복", emoji: "😊" },
  { id: "calm", label: "차분", emoji: "😌" },
  { id: "excited", label: "설렘", emoji: "💗" },
  { id: "tired", label: "피곤", emoji: "😴" },
];

const GRADIENTS = [
  "bg-gradient-to-br from-emerald-800 via-emerald-600 to-amber-100",
  "bg-gradient-to-br from-stone-700 via-amber-600 to-amber-100",
  "bg-gradient-to-br from-teal-700 via-stone-400 to-amber-50",
  "bg-gradient-to-br from-lime-800 via-lime-700 to-stone-200",
  "bg-gradient-to-br from-amber-800 via-amber-500 to-stone-100",
  "bg-gradient-to-br from-neutral-700 via-neutral-400 to-stone-100",
];

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
const moodOf = (id) => MOODS.find((m) => m.id === id);
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

/* ---------- GPS 현재 위치 → 장소명 (Nominatim 역지오코딩, API 키 불필요) ---------- */
const getCurrentPlace = () =>
  new Promise((resolve, reject) => {
    if (!navigator.geolocation)
      return reject(new Error("이 기기는 위치 기능을 지원하지 않아요"));
    navigator.geolocation.getCurrentPosition(
      async ({ coords: { latitude: lat, longitude: lon } }) => {
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
          resolve(
            name ||
            (d.display_name ? d.display_name.split(",").slice(0, 2).map((s) => s.trim()).reverse().join(" ") : "") ||
            `${lat.toFixed(4)}, ${lon.toFixed(4)}`
          );
        } catch {
          resolve(`${lat.toFixed(4)}, ${lon.toFixed(4)}`);
        }
      },
      (err) =>
        reject(new Error(
          err.code === 1
            ? "위치 권한이 거부되었어요. 브라우저 설정에서 허용해주세요"
            : "현재 위치를 가져오지 못했어요. 잠시 후 다시 시도해주세요"
        )),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });

/* ---------- Context (전역 상태) ---------- */
const DiaryContext = createContext(null);
const useDiary = () => useContext(DiaryContext);

/* ---------- Storage 사진 (경로 → URL 비동기 로드) ---------- */
function StoragePhoto({ img, className = "" }) {
  const [url, setUrl] = useState(img.preview || img.value || null);
  useEffect(() => {
    if (img.preview || img.value || !img.path) return;
    let on = true;
    getPhotoURL(img.path)
      .then((u) => on && setUrl(u))
      .catch(() => on && setUrl(null));
    return () => { on = false; };
  }, [img.path, img.preview, img.value]);
  if (!url)
    return (
      <div className={`w-full h-full flex items-center justify-center bg-neutral-500/10 ${className}`}>
        <ImageIcon size={22} className="opacity-30" />
      </div>
    );
  return <img src={url} alt="diary" className={`object-cover w-full h-full ${className}`} />;
}

/* ---------- 공용: 이미지(사진 or 그라디언트) ---------- */
function Img({ img, className = "" }) {
  if (!img) return <div className={`w-full h-full bg-neutral-500/10 ${className}`} />;
  if (img.type === "photo") return <StoragePhoto img={img} className={className} />;
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
  const mood = moodOf(entry.mood);

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
            {mood && <span className={`text-xs font-normal ${T.sub}`}>{mood.emoji} {mood.label}</span>}
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

      {/* 본문 */}
      {entry.text && (
        <div className="px-4 pb-4 pt-2">
          <RichText text={entry.text} />
        </div>
      )}
    </article>
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
              <Img img={list[0].images[0]} />
              <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-transparent" />
              <span className="absolute top-1 left-1.5 text-[11px] font-bold text-white drop-shadow">{day}</span>
              {(list.length > 1 || list[0].images.length > 1) && (
                <Layers size={13} className="absolute top-1 right-1 text-white drop-shadow" />
              )}
            </button>
          );
        })}
      </div>
      <p className={`mt-5 text-center text-xs ${T.sub}`}>기록이 있는 날짜를 누르면 그날의 일기가 열려요</p>
    </div>
  );
}

/* ---------- 리스트 뷰 — 월간 사진 타일 (3열) + 격자/피드 토글 ---------- */
function ListView() {
  const { T, accent, month, monthEntries, openDay, openEntry } = useDiary();
  const [mode, setMode] = useState("grid"); // grid | feed
  const sorted = useMemo(
    () => [...monthEntries].sort((a, b) => b.date.localeCompare(a.date)),
    [monthEntries]
  );

  return (
    <div className="mt-4">
      {/* 격자/피드 토글 */}
      <div className="px-4 flex justify-center mb-3">
        <div className={`inline-flex p-0.5 rounded-full ${T.input}`}>
          {[{ id: "grid", icon: LayoutGrid, label: "격자" }, { id: "feed", icon: Rows, label: "피드" }].map(({ id, icon: Icon, label }) => {
            const on = mode === id;
            return (
              <button key={id} onClick={() => setMode(id)}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold transition-colors ${on ? "text-white" : T.sub}`}
                style={on ? { backgroundColor: accent } : undefined}>
                <Icon size={13} /> {label}
              </button>
            );
          })}
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className={`text-center py-20 ${T.sub} text-sm`}>
          <ImageIcon size={40} className="mx-auto mb-3 opacity-40" />
          이번 달 기록이 아직 없어요
        </div>
      ) : mode === "grid" ? (
        <div className="grid grid-cols-3 gap-[3px] px-3">
          {sorted.map((e) => (
            <button key={e.id} onClick={() => openEntry(e)} className="relative aspect-[4/5] rounded-lg overflow-hidden group">
              <Img img={e.images[0]} />
              <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-transparent" />
              <span className="absolute top-1.5 left-2 text-xs font-bold text-white drop-shadow">{+e.date.slice(8)}</span>
              {e.images.length > 1 && <Layers size={14} className="absolute top-1.5 right-1.5 text-white drop-shadow" />}
            </button>
          ))}
        </div>
      ) : (
        <div className="max-w-md mx-auto px-4 space-y-4">
          {sorted.map((e) => <DiaryCard key={e.id} entry={e} />)}
        </div>
      )}
      <div className="h-2" />
      <p className={`text-center text-xs ${T.sub} pt-1`}>사진을 누르면 그날의 일기가 열려요</p>
    </div>
  );
}

/* ---------- 막대 그래프 (리포트 공용) ---------- */
function Bars({ data, accent, T }) {
  const max = Math.max(1, ...data.map((d) => d.v));
  return (
    <div className="flex items-end justify-between gap-2 h-28">
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center justify-end h-full">
          <div className="w-full flex-1 flex items-end justify-center">
            <div className="w-2.5 rounded-full transition-all"
              style={{ height: `${(d.v / max) * 100}%`, minHeight: d.v ? 6 : 4, backgroundColor: d.v ? accent : accent + "33" }} />
          </div>
          <div className={`mt-2 text-[11px] font-medium ${T.sub}`}>{d.label}</div>
          <div className={`text-[10px] ${T.sub} opacity-70`}>{d.v}회</div>
        </div>
      ))}
    </div>
  );
}

/* ---------- 월간 리포트 뷰 ---------- */
function ReportView() {
  const { T, accent, month, monthEntries } = useDiary();
  const daysInMonth = new Date(month.y, month.m + 1, 0).getDate();
  const recorded = new Set(monthEntries.map((e) => e.date)).size;
  const pct = daysInMonth ? (recorded / daysInMonth) * 100 : 0;

  const weekday = useMemo(() => {
    const c = [0, 0, 0, 0, 0, 0, 0];
    monthEntries.forEach((e) => { c[parseDate(e.date).getDay()]++; });
    return ["일", "월", "화", "수", "목", "금", "토"].map((label, i) => ({ label, v: c[i] }));
  }, [monthEntries]);

  const timeOfDay = useMemo(() => {
    const c = [0, 0, 0, 0, 0, 0];
    monthEntries.forEach((e) => { const h = hourOf(e); if (h != null) c[Math.floor(h / 4)]++; });
    return ["00-04", "04-08", "08-12", "12-16", "16-20", "20-24"].map((label, i) => ({ label, v: c[i] }));
  }, [monthEntries]);

  const words = useMemo(() => {
    const cnt = {};
    monthEntries.forEach((e) => extractTags(e.text).forEach((t) => { cnt[t] = (cnt[t] || 0) + 1; }));
    let arr = Object.entries(cnt).map(([w, v]) => ({ w, v }));
    if (arr.length === 0) {
      const mc = {};
      monthEntries.forEach((e) => { const m = moodOf(e.mood); if (m) mc[m.label] = (mc[m.label] || 0) + 1; });
      arr = Object.entries(mc).map(([w, v]) => ({ w, v }));
    }
    return arr.sort((a, b) => b.v - a.v).slice(0, 5);
  }, [monthEntries]);
  const wordMax = Math.max(1, ...words.map((w) => w.v));
  const hasTime = timeOfDay.some((t) => t.v > 0);

  return (
    <div className="max-w-md mx-auto pb-4">
      <MonthHeader overline="MONTHLY REPORT" />
      <div className="px-4 mt-5 space-y-4">
        {/* OVERVIEW */}
        <div className="rounded-2xl p-4" style={{ boxShadow: `0 0 0 2px ${accent}` }}>
          <div className={`text-[11px] font-bold tracking-widest ${T.sub} mb-1`}>OVERVIEW</div>
          <div className="flex items-end justify-between">
            <div className="flex items-end gap-1">
              <span className="text-3xl font-extrabold" style={{ color: accent }}>{recorded}</span>
              <span className={`text-sm ${T.sub} mb-1`}>/ {daysInMonth}일</span>
            </div>
            <span className={`text-sm font-semibold ${T.text}`}>{pct.toFixed(1)}% 달성</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden mt-2" style={{ backgroundColor: accent + "26" }}>
            <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: accent }} />
          </div>

          <div className={`mt-5 pt-4 border-t ${T.border}`}>
            <div className={`text-[11px] font-semibold ${T.sub} mb-2`}>요일별 기록</div>
            <Bars data={weekday} accent={accent} T={T} />
          </div>
          {hasTime && (
            <div className={`mt-4 pt-4 border-t ${T.border}`}>
              <div className={`text-[11px] font-semibold ${T.sub} mb-2`}>시간대별 기록</div>
              <Bars data={timeOfDay} accent={accent} T={T} />
            </div>
          )}
        </div>

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
                <div className="w-full"><Img img={img} className="!h-auto" /></div>
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
            {MOODS.map((m) => {
              const on = filter.mood === m.id;
              return (
                <button key={m.id}
                  onClick={() => setFilter((f) => ({ ...f, mood: on ? null : m.id }))}
                  className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${on ? "text-white border-transparent" : `${T.card} ${T.text} ${T.border} hover:opacity-70`}`}
                  style={on ? { backgroundColor: accent } : undefined}>
                  {m.emoji} {m.label}
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

/* ---------- 작성 / 편집 전체 페이지 ---------- */
function WritePage({ initial, onClose }) {
  const { T, accent, addEntry, updateEntry } = useDiary();
  const editing = !!initial?.id;
  const [date, setDate] = useState(initial?.date || todayStr());
  const [text, setText] = useState(initial?.text || "");
  const [location, setLocation] = useState(initial?.location || "");
  const [mood, setMood] = useState(initial?.mood || null);
  const [images, setImages] = useState(initial?.images || []);
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState(null);
  const fileRef = useRef(null);
  const tags = extractTags(text);

  const fillCurrentLocation = async () => {
    setLocError(null);
    setLocating(true);
    try { setLocation(await getCurrentPlace()); }
    catch (e) { setLocError(e.message); }
    finally { setLocating(false); }
  };

  const addPhotos = (files) => {
    [...files].slice(0, 5 - images.length).forEach((f) => {
      const r = new FileReader();
      r.onload = (ev) => setImages((imgs) =>
        imgs.length < 5 ? [...imgs, { type: "photo", preview: ev.target.result, file: f }] : imgs);
      r.readAsDataURL(f);
    });
  };
  const addGradient = () => {
    if (images.length >= 5) return;
    const g = GRADIENTS[Math.floor(Math.random() * GRADIENTS.length)];
    setImages((imgs) => [...imgs, { type: "gradient", value: g, label: "📷" }]);
  };
  const save = async () => {
    if ((!text.trim() && images.length === 0) || saving) return;
    setSaving(true);
    try {
      const data = { date, text: text.trim(), location: location.trim(), mood, images };
      if (editing) await updateEntry({ ...initial, ...data });
      else await addEntry(data);
      onClose();
    } catch (e) {
      console.error("저장 실패:", e);
      alert(`저장에 실패했어요: ${e.message}`);
    } finally { setSaving(false); }
  };

  return (
    <div className={`fixed inset-0 z-50 ${T.bg} overflow-y-auto`}>
      <div className={`sticky top-0 z-10 ${T.card} border-b ${T.border}`}>
        <div className="max-w-md mx-auto flex items-center justify-between px-4 py-3">
          <button onClick={onClose} disabled={saving} className={T.sub}><X size={22} /></button>
          <span className={`font-semibold text-sm ${T.text}`}>{editing ? "일기 수정" : "새 일기"}</span>
          <button onClick={save}
            disabled={(!text.trim() && images.length === 0) || saving}
            className="flex items-center gap-1 font-semibold text-sm disabled:opacity-40"
            style={{ color: accent }}>
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving ? "저장 중" : "저장"}
          </button>
        </div>
      </div>

      <div className="max-w-md mx-auto">
        <div className="p-4 pb-16 space-y-4">
          {/* 사진 (최대 5장) */}
          <div>
            <div className={`text-xs font-medium mb-2 ${T.sub}`}>사진 ({images.length}/5)</div>
            <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
              {images.map((img, i) => (
                <div key={i} className="relative w-20 h-20 flex-shrink-0 rounded-xl overflow-hidden">
                  <Img img={img} />
                  <button onClick={() => setImages(images.filter((_, j) => j !== i))}
                    className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center">
                    <X size={11} className="text-white" />
                  </button>
                </div>
              ))}
              {images.length < 5 && (
                <>
                  <button onClick={() => fileRef.current?.click()}
                    className={`w-20 h-20 flex-shrink-0 rounded-xl border-2 border-dashed ${T.border} flex flex-col items-center justify-center gap-1 ${T.sub} hover:opacity-70`}>
                    <ImageIcon size={20} /><span className="text-[10px]">업로드</span>
                  </button>
                  <button onClick={addGradient}
                    className={`w-20 h-20 flex-shrink-0 rounded-xl border-2 border-dashed ${T.border} flex flex-col items-center justify-center gap-1 ${T.sub} hover:opacity-70`}>
                    <Palette size={20} /><span className="text-[10px]">색상 카드</span>
                  </button>
                </>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
              onChange={(e) => { addPhotos(e.target.files); e.target.value = ""; }} />
          </div>

          {/* 본문 */}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder={"오늘 하루는 어땠나요?\n#해시태그 를 붙이면 모아볼 수 있어요"}
            className={`w-full ${T.input} rounded-xl p-3 text-sm outline-none resize-none ${T.text}`}
          />
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 -mt-2">
              {tags.map((t) => (
                <span key={t} className="text-xs px-2 py-0.5 rounded-full font-medium"
                  style={{ backgroundColor: accent + "1a", color: accent }}>#{t}</span>
              ))}
            </div>
          )}

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
                <input value={location} onChange={(e) => setLocation(e.target.value)}
                  placeholder="장소 추가"
                  className={`flex-1 min-w-0 bg-transparent text-sm outline-none ${T.text}`} />
                <button type="button" onClick={fillCurrentLocation} disabled={locating}
                  title="현재 위치 자동 입력" className="flex-shrink-0 disabled:opacity-50">
                  <LocateFixed size={15} style={locating ? { color: accent } : undefined}
                    className={locating ? "animate-pulse" : T.sub} />
                </button>
              </div>
            </label>
          </div>
          {locError && <p className="text-xs text-red-500 -mt-2">{locError}</p>}

          {/* 오늘의 기분 */}
          <div>
            <div className={`text-xs font-medium mb-2 ${T.sub}`}>오늘의 기분</div>
            <div className="flex flex-wrap gap-2">
              {MOODS.map((m) => {
                const on = mood === m.id;
                return (
                  <button key={m.id} onClick={() => setMood(on ? null : m.id)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${on ? "text-white border-transparent scale-105" : `${T.card} ${T.text} ${T.border} hover:opacity-70`}`}
                    style={on ? { backgroundColor: accent } : undefined}>
                    {m.emoji} {m.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
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
  const { T, accent, user, uname, entries, dark, setDark, openPhotoWall, openSettings, openEntry } = useDiary();
  const scrapped = useMemo(
    () => entries.filter((e) => e.scrapped).sort((a, b) => b.date.localeCompare(a.date)),
    [entries]
  );
  const stats = useMemo(() => ({
    logs: entries.length,
    tags: new Set(entries.flatMap((e) => extractTags(e.text))).size,
    months: new Set(entries.map((e) => e.date.slice(0, 7))).size,
    scraps: scrapped.length,
  }), [entries, scrapped]);

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

      {/* 스크랩 */}
      <div>
        <div className={`flex items-center gap-1.5 text-sm font-semibold ${T.text} mb-3`}>
          <Bookmark size={16} style={{ fill: accent, color: accent }} /> 스크랩 ({scrapped.length})
        </div>
        {scrapped.length === 0 ? (
          <div className={`text-center py-12 ${T.sub} text-sm ${T.card} border ${T.border} rounded-2xl`}>
            <Bookmark size={32} className="mx-auto mb-2 opacity-40" />
            일기의 북마크를 눌러 스크랩해보세요
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-[3px]">
            {scrapped.map((e) => (
              <button key={e.id} onClick={() => openEntry(e)} className="relative aspect-square rounded-lg overflow-hidden group">
                <Img img={e.images[0]} />
                <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-transparent" />
                <span className="absolute top-1 left-1.5 text-[11px] font-bold text-white drop-shadow">{+e.date.slice(8)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
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
        <Item id="calendar" icon={CalendarIcon} />
        <Item id="list" icon={LayoutGrid} />
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
export default function LifeLogApp() {
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem("lifelog-theme") === "dark"; } catch { return false; }
  });
  const [user, setUser] = useState(undefined);
  const [entries, setEntries] = useState([]);
  const [view, setView] = useState("calendar"); // calendar | list | report | profile
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
    return onAuthStateChanged(auth, setUser);
  }, []);

  useEffect(() => {
    if (!user) { setEntries([]); return; }
    return subscribeLogs(user.uid, setEntries, (e) => console.error("동기화 오류:", e));
  }, [user]);

  /* 테마 토큰 — DayPic 스타일 클린 화이트 (라이트/다크) */
  const T = dark
    ? { bg: "bg-[#111214]", card: "bg-[#1b1c1f]", text: "text-[#f1f1f3]", sub: "text-[#9a9ba1]", border: "border-[#2a2b30]", input: "bg-[#26272c]", icon: "text-[#f1f1f3]" }
    : { bg: "bg-[#f4f5f7]", card: "bg-white", text: "text-[#1a1a1c]", sub: "text-[#8a8f98]", border: "border-[#eceef1]", input: "bg-[#eef0f3]", icon: "text-[#1a1a1c]" };

  const accent = accentOf(month.m);

  if (!CONFIG_READY) return <SetupNotice T={T} />;
  if (user === undefined)
    return (
      <div className={`min-h-screen ${T.bg} flex items-center justify-center`}>
        <Loader2 size={28} className={`animate-spin ${T.sub}`} />
      </div>
    );
  if (!user) return <LoginScreen T={T} />;

  const addEntry = (data) => createLog(user.uid, data);
  const updateEntry = (entry) => {
    const prev = entries.find((e) => e.id === entry.id);
    return updateLog(user.uid, prev?.images || [], entry);
  };
  const deleteEntry = (id) => {
    const entry = entries.find((e) => e.id === id);
    if (entry) deleteLog(user.uid, entry).catch((e) => console.error("삭제 실패:", e));
  };
  const openEdit = (entry) => { setDetail(null); setEditTarget(entry); setWriteOpen(true); };
  const toggleScrap = (id) => {
    const entry = entries.find((e) => e.id === id);
    if (entry) setScrap(user.uid, id, !entry.scrapped).catch((e) => console.error("스크랩 실패:", e));
  };
  const openDay = (list) => setDetail({ mode: "day", key: list[0].date });
  const openEntry = (entry) => setDetail({ mode: "entry", key: entry.id });
  const openSearch = (tag) => { setFilter({ mood: null, tag: tag || null, query: "" }); setSearchOpen(true); };
  const openPhotoWall = () => setPhotoWallOpen(true);
  const openSettings = () => setSettingsOpen(true);

  const monthEntries = entries.filter((e) => e.date.startsWith(`${month.y}-${pad2(month.m + 1)}`));
  const uname = user.email ? user.email.split("@")[0] : "my.diary";

  const ctx = {
    T, dark, setDark, accent, user, uname, entries, monthEntries, filter, setFilter,
    view, setView, month, setMonth,
    addEntry, updateEntry, deleteEntry, openEdit, toggleScrap,
    openDay, openEntry, openSearch, openPhotoWall, openSettings,
  };

  const showHeader = view === "calendar" || view === "list";

  return (
    <DiaryContext.Provider value={ctx}>
      <div className={`min-h-screen ${T.bg} transition-colors`}>
        <main className="max-w-md mx-auto pb-28">
          {showHeader && (
            <MonthHeader
              right={
                <>
                  <button onClick={() => setSearchOpen(true)} className={`p-2 rounded-full hover:bg-neutral-500/10 ${T.icon}`}><Search size={20} strokeWidth={1.9} /></button>
                  <button onClick={() => setSettingsOpen(true)} className={`p-2 rounded-full hover:bg-neutral-500/10 ${T.icon}`}><Settings size={20} strokeWidth={1.8} /></button>
                </>
              }
            />
          )}
          {view === "calendar" && <CalendarView />}
          {view === "list" && <ListView />}
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
