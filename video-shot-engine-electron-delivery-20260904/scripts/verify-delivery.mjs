import fsp from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const required = [
  "src/server.mjs", "src/runtime-paths.mjs", "public/index.html", "package.json", "package-lock.json",
  ".env.example", "docs/electron-integration.md", "docs/api-reference.md", "docs/run-directory-layout.md",
  "docs/states-and-errors.md", "docs/ffmpeg-distribution.md", "fixtures/example-batch/batch.json", "DELIVERY_CHECKLIST.md",
];
const forbidden = [".env", ".service.json", "node_modules", "runs-v1", "service-logs", "provider-tests"];

for (const relative of required) await fsp.access(path.join(root, relative));
const leaked = [];
for (const relative of forbidden) {
  try { await fsp.access(path.join(root, relative)); leaked.push(relative); } catch {}
}
if (leaked.length) throw new Error(`交付包包含禁止项：${leaked.join(", ")}`);
console.log(JSON.stringify({ ok: true, requiredFiles: required.length, forbiddenItemsFound: 0 }));
