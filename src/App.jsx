import React, { useState, useMemo, useRef, useEffect, createContext, useContext } from "react";
import {
  Home, LayoutGrid, Calendar as CalendarIcon, Plus, Moon, Sun, X, Search,
  ChevronLeft, ChevronRight, MapPin, LocateFixed, Trash2, Pencil,
  Bookmark, MoreHorizontal, Image as ImageIcon, Layers, Palette, Hash,
  Settings, UploadCloud, LogOut, Loader2, Check,
} from "lucide-react";
import { auth, CONFIG_READY, signInWithGoogle, logOut } from "./firebase";
import { onAuthStateChanged } from "firebase/auth";
import { subscribeLogs, createLog, updateLog, deleteLog, setScrap } from "./db";
import { getPhotoURL } from "./photos";
import { importLegacyJSON } from "./migrate";

/* ================================================================
   LifeLog — 인스타그램 감성의 개인 다이어리 앱
   React + Tailwind CSS + lucide-react

   저장소: Cloud Firestore (users/{uid}/logs/{logId})
   - onSnapshot 실시간 동기화 + 오프라인 persistence
   - 사진: 압축(1600px/WebP) 후 Firebase Storage 업로드,
     문서에는 Storage 경로만 저장
   - 인증: Firebase Auth Google 로그인 (웹 팝업 / APK 네이티브 분기)
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
  "bg-gradient-to-br from-rose-300 via-fuchsia-300 to-indigo-400",
  "bg-gradient-to-br from-amber-200 via-orange-300 to-rose-400",
  "bg-gradient-to-br from-sky-300 via-cyan-300 to-emerald-300",
  "bg-gradient-to-br from-violet-300 via-purple-400 to-fuchsia-500",
  "bg-gradient-to-br from-lime-200 via-emerald-300 to-teal-400",
  "bg-gradient-to-br from-slate-300 via-slate-400 to-slate-600",
  "bg-gradient-to-br from-pink-200 via-rose-300 to-red-300",
  "bg-gradient-to-br from-indigo-300 via-blue-400 to-cyan-400",
];

const todayStr = () => new Date().toISOString().slice(0, 10);

/* ---------- 유틸 ---------- */
const extractTags = (text) => (text.match(/#[^\s#]+/g) || []).map((t) => t.slice(1));
const moodOf = (id) => MOODS.find((m) => m.id === id);
const fmtDate = (d) => {
  const [y, m, day] = d.split("-");
  return `${y}년 ${+m}월 ${+day}일`;
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
          resolve(`${lat.toFixed(4)}, ${lon.toFixed(4)}`); // 지오코딩 실패 시 좌표로 대체
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
        <ImageIcon size={24} className="opacity-30" />
      </div>
    );
  return <img src={url} alt="diary" className={`object-cover w-full h-full ${className}`} />;
}

/* ---------- 공용: 이미지(사진 or 그라디언트) ---------- */
function Img({ img, className = "" }) {
  if (img.type === "photo") return <StoragePhoto img={img} className={className} />;
  return (
    <div className={`w-full h-full flex items-center justify-center ${img.value} ${className}`}>
      <span className="text-5xl drop-shadow">{img.label || "📷"}</span>
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

/* ---------- 본문 텍스트 (해시태그 하이라이트 + 클릭 필터) ---------- */
function RichText({ text }) {
  const { T, setFilter, setView } = useDiary();
  return (
    <p className={`text-sm leading-relaxed whitespace-pre-wrap ${T.text}`}>
      {text.split(/(#[^\s#]+)/g).map((part, i) =>
        part.startsWith("#") ? (
          <button key={i}
            onClick={() => { setFilter((f) => ({ ...f, tag: part.slice(1) })); setView("feed"); }}
            className="text-sky-500 hover:underline font-medium">{part}</button>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </p>
  );
}

/* ---------- 피드 카드 ---------- */
function DiaryCard({ entry }) {
  const { T, uname, deleteEntry, openEdit, toggleScrap } = useDiary();
  const [menu, setMenu] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const mood = moodOf(entry.mood);

  return (
    <article className={`${T.card} sm:border ${T.border} sm:rounded-xl overflow-hidden`}>
      {/* 헤더 */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-9 h-9 rounded-full p-[2px] bg-gradient-to-tr from-amber-400 via-rose-500 to-fuchsia-600">
          <div className={`w-full h-full rounded-full ${T.card} flex items-center justify-center text-base`}>
            {mood?.emoji || "📔"}
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-semibold ${T.text}`}>
            {uname}
            {mood && (
              <span className={`ml-2 text-xs font-normal ${T.sub}`}>{mood.emoji} {mood.label}</span>
            )}
          </div>
          <div className={`text-xs ${T.sub} flex items-center gap-1 truncate`}>
            {fmtDate(entry.date)}
            {entry.location && (<><span>·</span><MapPin size={11} /><span className="truncate">{entry.location}</span></>)}
          </div>
        </div>
        <div className="relative">
          <button onClick={() => { setMenu(!menu); setConfirmDel(false); }} className={`p-1 ${T.sub} hover:opacity-70`}>
            <MoreHorizontal size={20} />
          </button>
          {menu && (
            <div className={`absolute right-0 top-8 z-20 w-36 ${T.card} border ${T.border} rounded-lg shadow-lg overflow-hidden`}>
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
          <Bookmark size={24} className={entry.scrapped ? "fill-amber-400 text-amber-400" : T.icon} strokeWidth={1.7} />
        </button>
      </div>

      {/* 본문 */}
      <div className="px-4 pb-4 pt-2">
        <RichText text={entry.text} />
      </div>
    </article>
  );
}

/* ---------- 필터 바 ---------- */
function FilterBar() {
  const { T, filter, setFilter } = useDiary();
  return (
    <div className="px-4 sm:px-0 space-y-2">
      <div className={`flex items-center gap-2 ${T.input} rounded-lg px-3 py-2`}>
        <Search size={16} className={T.sub} />
        <input
          value={filter.query}
          onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
          placeholder="내용·장소·태그 검색"
          className={`flex-1 bg-transparent text-sm outline-none ${T.text} placeholder:${T.subRaw}`}
        />
        {filter.query && <button onClick={() => setFilter((f) => ({ ...f, query: "" }))}><X size={14} className={T.sub} /></button>}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
        {filter.tag && (
          <button onClick={() => setFilter((f) => ({ ...f, tag: null }))}
            className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full bg-sky-500 text-white text-xs font-medium">
            <Hash size={12} />{filter.tag}<X size={12} />
          </button>
        )}
        {MOODS.map((m) => {
          const on = filter.mood === m.id;
          return (
            <button key={m.id}
              onClick={() => setFilter((f) => ({ ...f, mood: on ? null : m.id }))}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                on ? "bg-neutral-900 text-white border-neutral-900 dark-chip" : `${T.card} ${T.text} ${T.border} hover:opacity-70`
              }`}>
              {m.emoji} {m.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- 피드 뷰 ---------- */
function FeedView({ entries }) {
  const { T } = useDiary();
  return (
    <div className="space-y-4 sm:space-y-6">
      <FilterBar />
      {entries.length === 0 ? (
        <div className={`text-center py-20 ${T.sub} text-sm`}>
          <ImageIcon size={40} className="mx-auto mb-3 opacity-40" />
          조건에 맞는 일기가 없어요
        </div>
      ) : (
        entries.map((e) => <DiaryCard key={e.id} entry={e} />)
      )}
    </div>
  );
}

/* ---------- 그리드 뷰 (3열) ---------- */
function GridView({ entries, onOpen }) {
  const { T } = useDiary();
  return (
    <div>
      <div className={`flex items-center justify-center gap-8 py-3 border-b ${T.border} mb-[2px]`}>
        <div className="text-center">
          <div className={`text-lg font-bold ${T.text}`}>{entries.length}</div>
          <div className={`text-xs ${T.sub}`}>일기</div>
        </div>
        <div className="text-center">
          <div className={`text-lg font-bold ${T.text}`}>{new Set(entries.flatMap((e) => extractTags(e.text))).size}</div>
          <div className={`text-xs ${T.sub}`}>태그</div>
        </div>
        <div className="text-center">
          <div className={`text-lg font-bold ${T.text}`}>{new Set(entries.map((e) => e.date.slice(0, 7))).size}</div>
          <div className={`text-xs ${T.sub}`}>개월</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-[2px]">
        {entries.map((e) => (
          <button key={e.id} onClick={() => onOpen(e)} className="relative aspect-square overflow-hidden group">
            <Img img={e.images[0] || { type: "gradient", value: GRADIENTS[5], label: "📝" }} />
            {e.images.length > 1 && (
              <Layers size={16} className="absolute top-2 right-2 text-white drop-shadow" />
            )}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
              <span className="opacity-0 group-hover:opacity-100 text-white text-xs font-medium">{fmtDate(e.date)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- 달력 뷰 ---------- */
function CalendarView({ entries, onOpen }) {
  const { T } = useDiary();
  const [cur, setCur] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const byDate = useMemo(() => {
    const map = {};
    entries.forEach((e) => { (map[e.date] = map[e.date] || []).push(e); });
    return map;
  }, [entries]);

  const first = new Date(cur.y, cur.m, 1).getDay();
  const days = new Date(cur.y, cur.m + 1, 0).getDate();
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const move = (d) => setCur(({ y, m }) => {
    const nm = m + d;
    return { y: y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 };
  });

  return (
    <div className="px-4 sm:px-0">
      <div className="flex items-center justify-between mb-4">
        <button onClick={() => move(-1)} className={`p-2 ${T.sub} hover:opacity-70`}><ChevronLeft size={20} /></button>
        <div className={`font-semibold ${T.text}`}>{cur.y}년 {cur.m + 1}월</div>
        <button onClick={() => move(1)} className={`p-2 ${T.sub} hover:opacity-70`}><ChevronRight size={20} /></button>
      </div>
      <div className="grid grid-cols-7 mb-2">
        {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => (
          <div key={d} className={`text-center text-xs font-medium py-1 ${i === 0 ? "text-red-400" : T.sub}`}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((day, i) => {
          if (!day) return <div key={`e${i}`} />;
          const key = `${cur.y}-${String(cur.m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const list = byDate[key];
          const isToday = key === todayStr();
          return (
            <button key={key} disabled={!list}
              onClick={() => list && onOpen(list[0])}
              className={`aspect-square rounded-lg flex flex-col items-center justify-center gap-0.5 relative overflow-hidden border ${
                list ? `${T.border} hover:opacity-80` : "border-transparent"
              } ${isToday ? "ring-2 ring-sky-400" : ""}`}>
              {list ? (
                <>
                  <div className="absolute inset-0 opacity-90"><Img img={list[0].images[0]} /></div>
                  <span className="relative z-10 text-xs font-bold text-white drop-shadow">{day}</span>
                  <span className="relative z-10 flex gap-0.5">
                    {list.slice(0, 3).map((_, j) => <span key={j} className="w-1 h-1 rounded-full bg-white shadow" />)}
                  </span>
                </>
              ) : (
                <span className={`text-xs ${T.sub}`}>{day}</span>
              )}
            </button>
          );
        })}
      </div>
      <p className={`mt-4 text-xs ${T.sub} text-center`}>일기가 있는 날짜를 누르면 해당 일기가 열려요</p>
    </div>
  );
}

/* ---------- 작성 / 편집 전체 페이지 ---------- */
function WritePage({ initial, onClose }) {
  const { T, addEntry, updateEntry } = useDiary();
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

  /* GPS로 현재 위치 자동 입력 */
  const fillCurrentLocation = async () => {
    setLocError(null);
    setLocating(true);
    try {
      setLocation(await getCurrentPlace());
    } catch (e) {
      setLocError(e.message);
    } finally {
      setLocating(false);
    }
  };

  /* 새 사진: 미리보기(dataURL) + 원본 File 보관 → 저장 시 압축·업로드 */
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
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`fixed inset-0 z-50 ${T.bg} overflow-y-auto`}>
      {/* 페이지 헤더 */}
      <div className={`sticky top-0 z-10 ${T.card} border-b ${T.border}`}>
        <div className="max-w-md mx-auto flex items-center justify-between px-4 py-3">
          <button onClick={onClose} disabled={saving} className={T.sub}><X size={22} /></button>
          <span className={`font-semibold text-sm ${T.text}`}>{editing ? "일기 수정" : "새 일기"}</span>
          <button onClick={save}
            disabled={(!text.trim() && images.length === 0) || saving}
            className="flex items-center gap-1 text-sky-500 font-semibold text-sm disabled:opacity-40">
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
            <div className="flex gap-2 overflow-x-auto pb-1">
              {images.map((img, i) => (
                <div key={i} className="relative w-20 h-20 flex-shrink-0 rounded-lg overflow-hidden">
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
                    className={`w-20 h-20 flex-shrink-0 rounded-lg border-2 border-dashed ${T.border} flex flex-col items-center justify-center gap-1 ${T.sub} hover:opacity-70`}>
                    <ImageIcon size={20} /><span className="text-[10px]">업로드</span>
                  </button>
                  <button onClick={addGradient}
                    className={`w-20 h-20 flex-shrink-0 rounded-lg border-2 border-dashed ${T.border} flex flex-col items-center justify-center gap-1 ${T.sub} hover:opacity-70`}>
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
            className={`w-full ${T.input} rounded-lg p-3 text-sm outline-none resize-none ${T.text}`}
          />
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 -mt-2">
              {tags.map((t) => (
                <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-500 font-medium">#{t}</span>
              ))}
            </div>
          )}

          {/* 날짜 + 위치 */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={`text-xs font-medium ${T.sub}`}>날짜</span>
              <input type="date" value={date} max={todayStr()}
                onChange={(e) => setDate(e.target.value)}
                className={`mt-1 w-full ${T.input} rounded-lg px-3 py-2 text-sm outline-none ${T.text}`} />
            </label>
            <label className="block">
              <span className={`text-xs font-medium ${T.sub}`}>위치</span>
              <div className={`mt-1 flex items-center gap-1.5 ${T.input} rounded-lg px-3 py-2`}>
                <MapPin size={14} className={T.sub} />
                <input value={location} onChange={(e) => setLocation(e.target.value)}
                  placeholder="장소 추가"
                  className={`flex-1 min-w-0 bg-transparent text-sm outline-none ${T.text}`} />
                <button type="button" onClick={fillCurrentLocation} disabled={locating}
                  title="현재 위치 자동 입력"
                  className="flex-shrink-0 disabled:opacity-50">
                  <LocateFixed size={15}
                    className={locating ? "text-sky-500 animate-pulse" : `${T.sub} hover:text-sky-500`} />
                </button>
              </div>
            </label>
          </div>
          {locError && <p className="text-xs text-red-500 -mt-2">{locError}</p>}

          {/* 오늘의 기분 */}
          <div>
            <div className={`text-xs font-medium mb-2 ${T.sub}`}>오늘의 기분</div>
            <div className="flex flex-wrap gap-2">
              {MOODS.map((m) => (
                <button key={m.id} onClick={() => setMood(mood === m.id ? null : m.id)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                    mood === m.id
                      ? "bg-gradient-to-r from-rose-500 to-fuchsia-500 text-white border-transparent scale-105"
                      : `${T.card} ${T.text} ${T.border} hover:opacity-70`
                  }`}>
                  {m.emoji} {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- 스크랩 뷰 ---------- */
function ScrapView({ entries }) {
  const { T } = useDiary();
  const scrapped = entries
    .filter((e) => e.scrapped)
    .sort((a, b) => b.date.localeCompare(a.date));
  return (
    <div className="space-y-4 sm:space-y-6">
      <div className={`px-4 sm:px-0 flex items-center gap-1.5 text-sm font-semibold ${T.text}`}>
        <Bookmark size={16} className="fill-amber-400 text-amber-400" /> 스크랩 ({scrapped.length})
      </div>
      {scrapped.length === 0 ? (
        <div className={`text-center py-20 ${T.sub} text-sm`}>
          <Bookmark size={40} className="mx-auto mb-3 opacity-40" />
          아직 스크랩한 일기가 없어요
          <br />일기의 북마크 아이콘을 눌러 스크랩해보세요
        </div>
      ) : (
        scrapped.map((e) => <DiaryCard key={e.id} entry={e} />)
      )}
    </div>
  );
}

/* ---------- 단일 일기 뷰어 (그리드/달력에서 진입) ---------- */
function ViewerModal({ entry, onClose }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-0 sm:p-6" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto">
        <DiaryCard entry={entry} />
      </div>
      <button onClick={onClose} className="absolute top-4 right-4 text-white/80 hover:text-white"><X size={26} /></button>
    </div>
  );
}

/* ---------- 설정 모달 ---------- */
function SettingsModal({ onClose }) {
  const { T, dark, setDark, user } = useDiary();
  const importRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(null); // {done, total}
  const [importResult, setImportResult] = useState(null);

  const Section = ({ title, children }) => (
    <div className={`border-b ${T.border} pb-5 mb-5 last:border-0 last:pb-0 last:mb-0`}>
      <div className={`text-[11px] font-semibold tracking-wider mb-3 ${T.sub}`}>{title}</div>
      {children}
    </div>
  );

  /* 기존 Drive 백업 JSON → Firestore 일회성 마이그레이션 */
  const handleImport = async (file) => {
    if (!file || importing) return;
    setImporting(true);
    setImportResult(null);
    setImportProgress(null);
    try {
      const json = JSON.parse(await file.text());
      const total = Array.isArray(json) ? json.length : 0;
      if (total && !window.confirm(
        `${total}건의 일기를 가져옵니다. 같은 파일을 두 번 가져오면 중복 생성돼요. 계속할까요?`)) {
        setImporting(false);
        return;
      }
      const n = await importLegacyJSON(user.uid, json, (done, t) =>
        setImportProgress({ done, total: t }));
      setImportResult(`✅ ${n}건 가져오기 완료`);
    } catch (e) {
      console.error("가져오기 실패:", e);
      setImportResult(`가져오기 실패: ${e.message}`);
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
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
          {/* 계정 */}
          <Section title="계정">
            <div className="flex items-center gap-3">
              {user.photoURL ? (
                <img src={user.photoURL} alt="" referrerPolicy="no-referrer"
                  className="w-9 h-9 rounded-full" />
              ) : (
                <div className="w-9 h-9 rounded-full bg-white border border-neutral-200 flex items-center justify-center font-bold text-sm">
                  <span className="bg-gradient-to-r from-blue-500 via-red-500 to-amber-500 bg-clip-text text-transparent">G</span>
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

          {/* 데이터 */}
          <Section title="데이터">
            <div className="space-y-3">
              <div>
                <div className={`text-sm ${T.text}`}>기존 백업 가져오기</div>
                <div className={`text-xs ${T.sub}`}>
                  이전 Drive 백업 파일(lifelog-backup-*.json)을 Firestore로 옮깁니다. 1회만 실행하세요.
                </div>
              </div>
              <button onClick={() => importRef.current?.click()} disabled={importing}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-sky-500 text-white text-sm font-medium hover:bg-sky-600 disabled:opacity-40">
                {importing ? <Loader2 size={15} className="animate-spin" /> : <UploadCloud size={15} />}
                {importing
                  ? importProgress
                    ? `가져오는 중... ${importProgress.done}/${importProgress.total}`
                    : "가져오는 중..."
                  : "JSON 파일 선택"}
              </button>
              <input ref={importRef} type="file" accept="application/json,.json" className="hidden"
                onChange={(e) => { handleImport(e.target.files[0]); e.target.value = ""; }} />
              {importResult && (
                <div className={`text-xs flex items-center gap-1 ${importResult.startsWith("✅") ? "text-emerald-500" : "text-red-500"}`}>
                  {importResult.startsWith("✅") && <Check size={13} />}
                  {importResult}
                </div>
              )}
            </div>
          </Section>

          {/* 테마 */}
          <Section title="테마">
            <div className="flex gap-2">
              {[{ v: false, icon: Sun, label: "라이트" }, { v: true, icon: Moon, label: "다크" }].map(({ v, icon: Icon, label }) => (
                <button key={label} onClick={() => setDark(v)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                    dark === v
                      ? "bg-gradient-to-r from-rose-500 to-fuchsia-500 text-white border-transparent"
                      : `${T.card} ${T.text} ${T.border} hover:opacity-70`
                  }`}>
                  <Icon size={15} /> {label}
                </button>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

/* ---------- 하단 네비게이션 ---------- */
function BottomNav({ onWrite }) {
  const { T, view, setView } = useDiary();
  const Item = ({ id, icon: Icon }) => (
    <button onClick={() => setView(id)} className="flex-1 flex items-center justify-center py-3">
      <Icon size={24} strokeWidth={view === id ? 2.4 : 1.7}
        className={view === id ? T.text : T.sub} />
    </button>
  );
  return (
    <nav className={`fixed bottom-0 inset-x-0 ${T.card} border-t ${T.border} z-30`}>
      <div className="max-w-md mx-auto flex items-center">
        <Item id="feed" icon={Home} />
        <Item id="calendar" icon={CalendarIcon} />
        <button onClick={onWrite} className="flex-1 flex items-center justify-center py-2">
          <span className="w-11 h-11 rounded-xl bg-gradient-to-tr from-amber-400 via-rose-500 to-fuchsia-600 flex items-center justify-center shadow-lg hover:scale-105 transition-transform">
            <Plus size={24} className="text-white" />
          </span>
        </button>
        <Item id="grid" icon={LayoutGrid} />
        <Item id="scrap" icon={Bookmark} />
      </div>
    </nav>
  );
}

/* ---------- 로그인 화면 ---------- */
function LoginScreen({ T }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (e) {
      console.error("로그인 실패:", e);
      if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request")
        setError("로그인에 실패했어요. 잠시 후 다시 시도해주세요");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`min-h-screen ${T.bg} flex flex-col items-center justify-center px-8`}>
      <h1 className={`text-4xl font-bold mb-2 ${T.text}`} style={{ fontFamily: "'Segoe Script','cursive'" }}>
        LifeLog
      </h1>
      <p className={`text-sm mb-10 ${T.sub}`}>나만의 일기장 · 어느 기기에서나 같은 기록</p>
      <button onClick={login} disabled={busy}
        className={`w-full max-w-xs flex items-center justify-center gap-2 py-3 rounded-xl border ${T.border} ${T.card} text-sm font-medium ${T.text} hover:opacity-80 disabled:opacity-40`}>
        {busy ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <span className="font-bold bg-gradient-to-r from-blue-500 via-red-500 to-amber-500 bg-clip-text text-transparent">G</span>
        )}
        Google 계정으로 시작하기
      </button>
      {error && <p className="mt-4 text-xs text-red-500">{error}</p>}
    </div>
  );
}

/* ---------- Firebase 설정 안내 화면 (firebase-config.js 미입력 시) ---------- */
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

/* ---------- App (루트) ---------- */
export default function LifeLogApp() {
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem("lifelog-theme") === "dark"; } catch { return false; }
  });
  const [user, setUser] = useState(undefined); // undefined=확인 중, null=미로그인
  const [entries, setEntries] = useState([]);
  const [view, setView] = useState("feed"); // feed | grid | calendar | scrap
  const [filter, setFilter] = useState({ mood: null, tag: null, query: "" });
  const [writeOpen, setWriteOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [viewer, setViewer] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /* 테마 영속화 */
  useEffect(() => {
    try { localStorage.setItem("lifelog-theme", dark ? "dark" : "light"); } catch { /* noop */ }
  }, [dark]);

  /* 인증 상태 구독 */
  useEffect(() => {
    if (!CONFIG_READY) return;
    return onAuthStateChanged(auth, setUser);
  }, []);

  /* Firestore 실시간 구독 (로그인 시) */
  useEffect(() => {
    if (!user) { setEntries([]); return; }
    return subscribeLogs(user.uid, setEntries, (e) => console.error("동기화 오류:", e));
  }, [user]);

  /* 열려 있는 뷰어를 최신 데이터와 동기화 (수정/삭제 반영) */
  useEffect(() => {
    setViewer((v) => (v ? entries.find((e) => e.id === v.id) || null : v));
  }, [entries]);

  /* 테마 토큰 (라이트/다크) */
  const T = dark
    ? { bg: "bg-black", card: "bg-neutral-900", text: "text-neutral-100", sub: "text-neutral-400", subRaw: "text-neutral-500", border: "border-neutral-800", input: "bg-neutral-800", icon: "text-neutral-100" }
    : { bg: "bg-neutral-50", card: "bg-white", text: "text-neutral-900", sub: "text-neutral-500", subRaw: "text-neutral-400", border: "border-neutral-200", input: "bg-neutral-100", icon: "text-neutral-900" };

  if (!CONFIG_READY) return <SetupNotice T={T} />;
  if (user === undefined)
    return (
      <div className={`min-h-screen ${T.bg} flex items-center justify-center`}>
        <Loader2 size={28} className={`animate-spin ${T.sub}`} />
      </div>
    );
  if (!user) return <LoginScreen T={T} />;

  /* CRUD → Firestore (화면 반영은 onSnapshot이 담당) */
  const addEntry = (data) => createLog(user.uid, data);
  const updateEntry = (entry) => {
    const prev = entries.find((e) => e.id === entry.id);
    return updateLog(user.uid, prev?.images || [], entry);
  };
  const deleteEntry = (id) => {
    const entry = entries.find((e) => e.id === id);
    if (entry) deleteLog(user.uid, entry).catch((e) => console.error("삭제 실패:", e));
  };
  const openEdit = (entry) => { setEditTarget(entry); setWriteOpen(true); };
  const toggleScrap = (id) => {
    const entry = entries.find((e) => e.id === id);
    if (entry) setScrap(user.uid, id, !entry.scrapped).catch((e) => console.error("스크랩 실패:", e));
  };

  /* 필터링 + 최신순 정렬 */
  const filtered = entries
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

  const uname = user.email ? user.email.split("@")[0] : "my.diary";
  const ctx = { T, dark, setDark, user, uname, entries, filter, setFilter, view, setView, addEntry, updateEntry, deleteEntry, openEdit, toggleScrap };

  return (
    <DiaryContext.Provider value={ctx}>
      <div className={`min-h-screen ${T.bg} transition-colors`}>
        {/* 상단 헤더 */}
        <header className={`sticky top-0 z-30 ${T.card} border-b ${T.border}`}>
          <div className="max-w-md mx-auto flex items-center justify-between px-4 py-3">
            <h1 className={`text-xl font-bold tracking-tight ${T.text}`} style={{ fontFamily: "'Segoe Script','cursive'" }}>
              LifeLog
            </h1>
            <button onClick={() => setSettingsOpen(true)} className={`p-2 rounded-full hover:bg-neutral-500/10 ${T.icon}`}>
              <Settings size={20} strokeWidth={1.7} />
            </button>
          </div>
        </header>

        {/* 메인 */}
        <main className="max-w-md mx-auto pt-4 pb-24 sm:px-0">
          {view === "feed" && <FeedView entries={filtered} />}
          {view === "grid" && <GridView entries={filtered} onOpen={setViewer} />}
          {view === "calendar" && <CalendarView entries={filtered} onOpen={setViewer} />}
          {view === "scrap" && <ScrapView entries={entries} />}
        </main>

        <BottomNav onWrite={() => { setEditTarget(null); setWriteOpen(true); }} />

        {writeOpen && <WritePage initial={editTarget} onClose={() => setWriteOpen(false)} />}
        {viewer && <ViewerModal entry={viewer} onClose={() => setViewer(null)} />}
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      </div>
    </DiaryContext.Provider>
  );
}
