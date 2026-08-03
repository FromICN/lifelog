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
  });
}
