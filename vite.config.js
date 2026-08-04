import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// - GitHub Pages(웹): base "/lifelog/" (https://<username>.github.io/lifelog/)
// - Capacitor APK: 로컬 파일에서 로드되므로 상대 경로("./") 필요
//   → npm run build:app (CAP_BUILD=1) 사용
export default defineConfig({
  plugins: [react()],
  base: process.env.CAP_BUILD ? "./" : "/lifelog/",

  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        /* 벤더를 분리하는 이유
           1) 총 바이트는 같지만 다운로드·파싱이 병렬화됩니다.
           2) 더 중요한 건 캐시입니다. 앱 코드만 고친 배포에서는
              react/firestore/auth 청크의 파일명이 그대로라
              서비스워커의 assets 캐시(cache-first)에서 재사용됩니다.
              업데이트 후 첫 실행에서 받아야 할 양이 크게 줄어듭니다. */
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@firebase/firestore") || id.includes("webchannel-wrapper"))
            return "vendor-firestore";
          if (id.includes("@firebase/auth")) return "vendor-auth";
          if (id.includes("react-dom") || id.includes("/scheduler/")) return "vendor-react";
        },
      },
    },
  },
});
