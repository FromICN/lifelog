import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages: https://<username>.github.io/lifelog/
export default defineConfig({
  plugins: [react()],
  base: "/lifelog/",
});
