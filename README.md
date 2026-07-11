# LifeLog — 에디토리얼 크림 디자인 적용 파일

`fromicn/lifelog` 저장소에 그대로 덮어써서 커밋하면 되는 두 파일입니다.

## 반영 방법
1. `index.html` → 저장소 루트의 `index.html`을 이 파일로 교체 (Newsreader 폰트 링크 추가됨)
2. `src/App.jsx` → 저장소의 `src/App.jsx`를 이 파일로 교체
3. 그 외 파일(`firebase.js`, `db.js`, `photos.js`, `migrate.js` 등)은 변경 없음 — 그대로 두면 됩니다.
4. `git add -A && git commit -m "디자인: 에디토리얼 크림 톤 적용" && git push` → main에 푸시하면 GitHub Actions가 자동 배포합니다.

## 무엇이 바뀌었나
- **팔레트**: 흰 배경 + 하늘색(sky-500) 악센트 → 크림 배경(`#f2ecdf`/다크 `#1c1a16`) + 딥올리브 악센트(emerald-700/800)
- **워드마크**: cursive 필기체 → `Newsreader` 이탤릭 세리프 (index.html에 Google Fonts 링크 추가)
- **그라디언트 카드**: 무지개톤 8종 → 올리브·크림 듀오톤 6종
- **아바타 링 · 작성(+) 버튼 · 선택된 기분칩**: 3색 레인보우 그라디언트 → 앰버→올리브 2색 그라디언트
- **해시태그·버튼·포인트 컬러**: sky-500/600 전체를 emerald-700/800으로 치환
- 레이아웃, 인터랙션, Firebase 연동 로직은 기존과 동일 — 색상·타이포그래피만 교체했습니다.

## 참고
색상은 Tailwind 임의값(`bg-[#f2ecdf]` 등)으로 넣었기 때문에 `tailwind.config.js` 수정 없이 그대로 동작합니다.
