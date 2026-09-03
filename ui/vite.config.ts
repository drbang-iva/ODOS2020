import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { buildProvenancePlugin } from "./build-provenance";
import { loopbackBuildGuardPlugin } from "./loopback-build-guard";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const mcpTarget = env.ODOS_MCP_PROXY_TARGET || "http://localhost:3333";

  return {
    plugins: [react(), buildProvenancePlugin(), loopbackBuildGuardPlugin()],
    server: {
      port: 5173,
      proxy: {
        "/fhir": { target: "http://localhost:8103", changeOrigin: true },
        "/auth": { target: "http://localhost:8103", changeOrigin: true },
        "/oauth2": { target: "http://localhost:8103", changeOrigin: true },
        // odos-core payment charge boundary (processor secrets live server-side only)
        "/payments": { target: mcpTarget, changeOrigin: true },
        "/commercial-engine": { target: mcpTarget, changeOrigin: true },
        "/series-tracker": { target: mcpTarget, changeOrigin: true },
        "/claims": { target: mcpTarget, changeOrigin: true },
        "/eligibility": { target: mcpTarget, changeOrigin: true },
        "/statements": { target: mcpTarget, changeOrigin: true },
        "/reports": { target: mcpTarget, changeOrigin: true },
        "/practice": { target: mcpTarget, changeOrigin: true },
        "/scheduling": { target: mcpTarget, changeOrigin: true },
        "/lab-orders": { target: mcpTarget, changeOrigin: true },
        "/insurance": { target: mcpTarget, changeOrigin: true },
        "/referrals": { target: mcpTarget, changeOrigin: true },
        "/correspondence": { target: mcpTarget, changeOrigin: true },
        "/fax": { target: mcpTarget, changeOrigin: true },
        "/mcp": { target: mcpTarget, changeOrigin: true },
        "/communications": { target: mcpTarget, changeOrigin: true },
        "/watchers": { target: mcpTarget, changeOrigin: true },
        "/inventory": { target: mcpTarget, changeOrigin: true },
        "/audit": {
          target: mcpTarget,
          changeOrigin: true,
          bypass(req) {
            if (req.headers["sec-fetch-dest"] === "document" || (req.headers.accept || "").includes("text/html")) {
              return "/index.html";
            }
          },
        },
        "/desk": {
          target: mcpTarget,
          changeOrigin: true,
          bypass(req) {
            if (req.headers["sec-fetch-dest"] === "document" || (req.headers.accept || "").includes("text/html")) {
              return "/index.html";
            }
          },
        },
        "/clinic": {
          target: mcpTarget,
          changeOrigin: true,
          bypass(req) {
            if (req.headers["sec-fetch-dest"] === "document" || (req.headers.accept || "").includes("text/html")) {
              return "/index.html";
            }
          },
        },
        "/clinical-graph": { target: mcpTarget, changeOrigin: true },
        "/weno": { target: mcpTarget, changeOrigin: true },
      },
    },
  };
});
