import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(projectRoot, "node_modules", "app-builder-lib", "out", "targets", "nsis", "NsisTarget.js");
const before = 'await wineVm.exec(installerPath, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });';
const after = 'await wineVm.exec(installerPath, [], { env: { ...process.env, __COMPAT_LAYER: "RunAsInvoker" } });';
const source = await readFile(target, "utf8");

if (source.includes(after)) {
  console.log("electron-builder NSIS environment patch already applied");
} else if (source.includes(before)) {
  await writeFile(target, source.replace(before, after), "utf8");
  console.log("electron-builder NSIS environment patch applied");
} else {
  throw new Error("electron-builder NSIS patch target was not found; review the installed builder version");
}
