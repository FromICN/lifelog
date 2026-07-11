# LifeLog

인스타그램 감성의 개인 다이어리 앱. React (Vite) + Tailwind CSS + Firebase.

## 주요 기능
- 피드 / 3열 그리드 / 달력 / 스크랩 뷰
- 일기 CRUD, 사진 최대 5장 캐러셀, 해시태그·감정 태그 필터
- Firebase Auth Google 로그인 — 어느 기기에서나 같은 데이터
- Cloud Firestore 실시간 동기화(`users/{uid}/logs/{logId}`) + 오프라인 지원
- 사진: 클라이언트 압축(긴 변 1600px, WebP) 후 Firebase Storage 저장
- 기존 Drive 백업 JSON 일회성 마이그레이션 (설정 → 데이터)
- Capacitor 안드로이드 APK 패키징 지원

## 설정
**`FIREBASE_SETUP.md`** 체크리스트를 따라 Firebase 콘솔 설정 후,
`src/firebase-config.js`에 웹 앱 설정을 붙여넣으세요.

## 실행
```bash
npm install
npm run dev        # 웹 개발 서버
npm run build      # GitHub Pages용 빌드 (base: /lifelog/)
npm run build:app  # APK용 빌드 (상대경로) + cap sync
```

## 배포
`main` 브랜치에 push하면 GitHub Actions가 자동으로 GitHub Pages에 배포합니다.

## 구조
```
src/
  App.jsx             UI (단일 파일)
  firebase.js         초기화 + Google 로그인 (웹/네이티브 분기)
  firebase-config.js  Firebase 콘솔 설정 붙여넣는 곳
  db.js               Firestore CRUD + onSnapshot 구독
  photos.js           사진 압축·업로드·URL 캐시
  migrate.js          Drive 백업 JSON → Firestore 마이그레이션
firestore.rules       Firestore 보안 규칙 (본인만 접근)
storage.rules         Storage 보안 규칙 (본인만 접근)
capacitor.config.json Capacitor 설정 (com.fromicn.lifelog)
```
