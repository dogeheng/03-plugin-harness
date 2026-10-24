import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The daemon serves apps/web/dist on http://127.0.0.1:<port>. For UI development run the
// daemon as usual, sign in once with `harness open`, then:
//   HARNESS_UI_DEV_ORIGIN=http://127.0.0.1:5173 harness daemon restart
//   pnpm --filter @harness/web dev
// The proxy rewrites Host/Origin so the daemon's DNS-rebinding and CSRF checks still pass.
const daemon = `http://127.0.0.1:${process.env.HARNESS_PORT ?? 47821}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: daemon,
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => req.setHeader("origin", daemon));
          proxy.on("proxyReqWs", (req) => req.setHeader("origin", daemon));
        },
      },
      "/auth": { target: daemon, changeOrigin: true },
    },
  },
});
