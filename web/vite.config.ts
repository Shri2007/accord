import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// Share previews need absolute URLs; point them at the production site from site.json.
const site = JSON.parse(readFileSync(here("../site.json"), "utf8"));

export default defineConfig({
  plugins: [
    react(),
    { name: "site-url", transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", site.production) },
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
