import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const port = Number(process.argv[2] || 4174);
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".webp": "image/webp"
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
    const target = resolve(root, `.${pathname === "/" ? "/electron/renderer/index.html" : pathname}`);
    if (relative(root, target).startsWith("..")) throw new Error("Forbidden");
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Not found");
    response.writeHead(200, { "Content-Type": types[extname(target).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(target).pipe(response);
  } catch (error) {
    response.writeHead(error.message === "Forbidden" ? 403 : 404);
    response.end(error.message);
  }
}).listen(port, "127.0.0.1", () => console.log(`Renderer preview: http://127.0.0.1:${port}/electron/renderer/`));
