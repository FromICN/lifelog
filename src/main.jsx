import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

/* PWA 서비스워커 등록 (웹 전용) — Capacitor 네이티브 앱에서는 건너뜀 */
if (
  "serviceWorker" in navigator &&
  window.isSecureContext &&
  !window.Capacitor
) {
  const base = import.meta.env.BASE_URL || "/";
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .catch((err) => console.warn("서비스워커 등록 실패:", err));

    /* 새 배포가 도착하면 1회만 새로고침해 즉시 반영한다.
       (기존에는 "다음 실행에 반영"이라, 배포 직후 확인하면 예전 버전이 떴다) */
    let reloaded = false;
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type !== "SHELL_UPDATED" || reloaded) return;
      reloaded = true;
      console.info("[LifeLog] 새 버전이 도착해 새로고침합니다");
      location.reload();
    });
  });
}
