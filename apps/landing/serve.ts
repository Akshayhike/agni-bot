import { join } from "path";

const PORT = Number(process.env.PORT) || 3000;
const DIR = import.meta.dir;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") {
      pathname = "/index.html";
    }

    // Try apps/landing/<path>
    let filePath = join(DIR, pathname);
    let file = Bun.file(filePath);

    // If not found in DIR, try apps/landing/public/<path>
    if (!file.size) {
      filePath = join(DIR, "public", pathname);
      file = Bun.file(filePath);
    }

    if (file.size > 0) {
      const ext = pathname.substring(pathname.lastIndexOf("."));
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      return new Response(file, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-cache",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`🔥 Agni landing page serving at http://localhost:${server.port}`);
