import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/fhir": { target: "http://localhost:8103", changeOrigin: true },
      "/auth": { target: "http://localhost:8103", changeOrigin: true },
      "/oauth2": { target: "http://localhost:8103", changeOrigin: true },
    },
  },
});
