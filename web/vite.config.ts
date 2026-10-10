import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// Share previews need absolute URLs. SITE_URL wins if set; on Vercel, fall back to the project's
// production domain, which Vercel exposes at build time; otherwise use the Sites URL in site.json.
function siteUrl(): string {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  try {
    return JSON.parse(readFileSync(here("../site.json"), "utf8")).production;
  } catch {
    return "";
  }
}

export default defineConfig({
  plugins: [
    react(),
    { name: "site-url", transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", siteUrl()) },
    {
      // Production serves /story from story.html; mirror that in the dev server.
      name: "story-route",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === "/story" || req.url?.startsWith("/story?")) req.url = req.url.replace("/story", "/story.html");
          next();
        });
      },
    },
  ],
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: { input: { main: here("index.html"), story: here("story.html") } },
  },
});
