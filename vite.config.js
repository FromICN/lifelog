import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// - GitHub Pages(웹): base "/lifelog/" (https://<username>.github.io/lifelog/)
// - Capacitor APK: 로컬 파일에서 로드되므로 상대 경로("./") 필요
//   → npm run build:app (CAP_BUILD=1) 사용
export default defineConfig({
  plugins: [react()],
  base: process.env.CAP_BUILD ? "./" : "/lifelog/",
});
