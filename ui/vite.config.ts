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
      // osod-core payment charge boundary (processor secrets live server-side only)
      "/payments": { target: "http://localhost:3333", changeOrigin: true },
      "/claims": { target: "http://localhost:3333", changeOrigin: true },
      "/statements": { target: "http://localhost:3333", changeOrigin: true },
      "/desk": {
        target: "http://localhost:3333",
        changeOrigin: true,
        bypass(req) {
          if (req.headers["sec-fetch-dest"] === "document" || (req.headers.accept || "").includes("text/html")) {
            return "/index.html";
          }
        },
      },
      "/clinic": {
        target: "http://localhost:3333",
        changeOrigin: true,
        bypass(req) {
          if (req.headers["sec-fetch-dest"] === "document" || (req.headers.accept || "").includes("text/html")) {
            return "/index.html";
          }
        },
      },
      "/clinical-graph": { target: "http://localhost:3333", changeOrigin: true },
    },
  },
});
