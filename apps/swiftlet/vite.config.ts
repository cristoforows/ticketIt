import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Single documented place for Galley's dev-proxy target (acceptance
// criterion: "Dev-server proxying of /api/* is configured and
// documented in one place"). Set GALLEY_PROXY_TARGET before running
// `npm run dev` / `npm run build` / `npm run preview`, e.g.:
//
//   GALLEY_PROXY_TARGET=http://localhost:9090 npm run dev
//
// or place GALLEY_PROXY_TARGET=... in a .env / .env.local file in this
// directory (loadEnv below picks up any variable, not only VITE_-
// prefixed ones). Falls back to http://localhost:8080, Galley's planned
// local address, when unset. See README.md, "Galley address
// configuration".
const DEFAULT_GALLEY_PROXY_TARGET = "http://localhost:8080";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const galleyProxyTarget = env.GALLEY_PROXY_TARGET || DEFAULT_GALLEY_PROXY_TARGET;

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: galleyProxyTarget,
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      css: false,
    },
  };
});
