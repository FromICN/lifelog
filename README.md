# LifeLog

인스타그램 감성의 개인 다이어리 앱. React (Vite) + Tailwind CSS + lucide-react.

## 주요 기능
- 피드 / 3열 그리드 / 달력 / 스크랩 뷰
- 일기 CRUD, 사진 최대 5장 캐러셀, 해시태그·감정 태그 필터
- 설정: Google 계정 연동, Drive 일자별 백업(최대 7일 보관), 라이트/다크 테마

## 실행
```bash
npm install
npm run dev
```

## Google Drive 백업 활성화
`src/App.jsx` 상단의 `GOOGLE_CLIENT_ID`에 Google Cloud Console에서 발급받은
OAuth Client ID를 입력하세요. 미입력 시 데모 모드로 동작합니다.

## 배포
`main` 브랜치에 push하면 GitHub Actions가 자동으로 GitHub Pages에 배포합니다.
