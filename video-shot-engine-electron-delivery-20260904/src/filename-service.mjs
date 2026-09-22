import path from "node:path";

const ILLEGAL_WINDOWS_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const TRAILING_DOTS_OR_SPACES = /[. ]+$/g;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFilenamePart(value, fallback = "待确认", maxLength = 28) {
  let result = String(value || "")
    .replace(ILLEGAL_WINDOWS_CHARS, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[_\s]+/g, " ")
    .trim()
    .replace(TRAILING_DOTS_OR_SPACES, "");
  if (!result) result = fallback;
  if (RESERVED_WINDOWS_NAMES.test(result)) result = `${result}_素材`;
  return [...result].slice(0, maxLength).join("").trim().replace(TRAILING_DOTS_OR_SPACES, "") || fallback;
}

export function createNamedFilename(label, index, sourcePath) {
  const title = sanitizeFilenamePart(label.contentTitle, "内容待确认", 42);
  const extension = path.extname(sourcePath).toLowerCase() || ".mp4";
  return `${title}${extension}`;
}

export function createUniqueFilename(filename, usedNames) {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  let candidate = filename;
  let duplicateIndex = 2;
  while (usedNames.has(candidate.toLocaleLowerCase("zh-CN"))) {
    candidate = `${stem}（${duplicateIndex}）${extension}`;
    duplicateIndex += 1;
  }
  usedNames.add(candidate.toLocaleLowerCase("zh-CN"));
  return candidate;
}
