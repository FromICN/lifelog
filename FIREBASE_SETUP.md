# Firebase + Capacitor 설정 체크리스트

직접 해야 하는 작업입니다. 순서대로 진행하세요.
A(1~7)까지 하면 웹에서 동기화가 동작하고, B(8~13)까지 하면 APK가 완성됩니다.

---

## A. Firebase 콘솔 (웹 동기화까지)

### 1. 프로젝트 생성
- [ ] https://console.firebase.google.com → **프로젝트 추가** (예: `lifelog`)
- [ ] Google 애널리틱스는 꺼도 무방

### 2. Google 로그인 활성화
- [ ] 빌드 → **Authentication** → 시작하기 → 로그인 방법 → **Google** 사용 설정
- [ ] 프로젝트 지원 이메일 선택 후 저장

### 3. 웹 앱 등록 + 설정 붙여넣기
- [ ] 프로젝트 개요 → ⚙️ 프로젝트 설정 → 일반 → 내 앱 → **웹 앱 추가(`</>`)** (닉네임: lifelog-web, 호스팅 체크 불필요)
- [ ] 표시되는 `firebaseConfig` 객체를 복사해 **`src/firebase-config.js`**에 붙여넣기

### 4. Firestore 생성 + 보안 규칙
- [ ] 빌드 → **Firestore Database** → 데이터베이스 만들기 → **프로덕션 모드** → 리전 `asia-northeast3`(서울)
- [ ] **규칙** 탭에 저장소의 `firestore.rules` 내용을 붙여넣고 게시

### 5. Storage 생성 + 보안 규칙
- [ ] 빌드 → **Storage** → 시작하기 (Firestore와 같은 리전)
- [ ] **규칙** 탭에 `storage.rules` 내용을 붙여넣고 게시

### 6. 승인된 도메인 확인
- [ ] Authentication → 설정 → **승인된 도메인**에 다음이 있는지 확인:
  - `localhost` (기본 포함)
  - **`fromicn.github.io`** ← GitHub Pages용, 직접 추가

### 7. 웹에서 확인
```bash
npm install
npm run dev
```
- [ ] Google 로그인 → 일기 작성 → 다른 브라우저/기기에서 로그인 → 실시간 반영 확인
- [ ] 설정 → 데이터 → **기존 백업 가져오기**로 이전 Drive 백업 JSON을 1회 마이그레이션
- [ ] `main`에 push → GitHub Pages에서도 로그인·동기화 확인

---

## B. 안드로이드 APK (Capacitor)

### 8. Capacitor 안드로이드 플랫폼 추가
```bash
npx cap add android
```
(`capacitor.config.json`은 이미 포함됨. 패키지명: `com.fromicn.lifelog`)

### 9. Firebase에 안드로이드 앱 등록
- [ ] 프로젝트 설정 → 일반 → 내 앱 → **안드로이드 앱 추가**
- [ ] 패키지 이름: **`com.fromicn.lifelog`** (capacitor.config.json의 appId와 반드시 동일)

### 10. SHA-1 지문 등록 (Google 로그인 필수)
- [ ] 디버그 SHA-1 확인:
```bash
cd android && gradlew signingReport      # Windows
# 또는
keytool -list -v -keystore %USERPROFILE%\.android\debug.keystore -alias androiddebugkey -storepass android
```
- [ ] 안드로이드 앱 설정 → **디지털 지문 추가**에 SHA-1 붙여넣기
- [ ] 나중에 릴리즈 키스토어로 서명할 경우 **릴리즈 SHA-1도 추가**

### 11. google-services.json 배치
- [ ] 안드로이드 앱 설정에서 **google-services.json 다운로드**
- [ ] **`android/app/google-services.json`** 위치에 복사

### 12. 빌드 + 실행
```bash
npm run build:app        # 상대경로 빌드 + cap sync android
npx cap open android     # Android Studio에서 열기 → 기기/에뮬레이터 실행
```
- [ ] APK에서 Google 로그인 → 웹과 같은 데이터가 보이는지 확인

### 13. 릴리즈 APK (배포용)
- [ ] Android Studio → Build → Generate Signed App Bundle/APK → 키스토어 생성
- [ ] 릴리즈 키스토어의 SHA-1을 10번처럼 Firebase에 추가 (누락 시 릴리즈 빌드에서 로그인 실패)

---

## 참고 사항

- **마이그레이션은 1회만**: 같은 JSON을 두 번 가져오면 일기가 중복 생성됩니다.
- **오프라인**: 텍스트 작성/수정은 오프라인에서도 저장되고 재접속 시 자동 동기화됩니다. 사진 업로드는 네트워크 연결 시 완료됩니다.
- **사진 경로**: `users/{uid}/photos/{logId}_{n}.webp` (긴 변 1600px, WebP, 약 200~400KB)
- **데이터 구조**: `users/{uid}/logs/{logId}` — tasklog도 같은 프로젝트에서 `users/{uid}/tasks/{taskId}`로 확장하면 됩니다 (보안 규칙은 이미 `users/{uid}/**` 전체를 커버).
- **Drive 백업 코드 제거됨**: Google Cloud Console의 기존 OAuth Client ID는 더 이상 필요 없습니다.
