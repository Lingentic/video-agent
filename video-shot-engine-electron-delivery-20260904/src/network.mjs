import { ProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

export function configureHttpsProxy(proxyUrl) {
  if (!proxyUrl) return false;
  const parsed = new URL(proxyUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("GEMINI_HTTPS_PROXY 只支持 http:// 或 https:// 地址");
  const dispatcher = new ProxyAgent(parsed.toString());
  setGlobalDispatcher(dispatcher);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init = {}) => {
    if (typeof input === "object" && input !== null && typeof input.url === "string") {
      return nativeFetch(input, { ...init, dispatcher: init.dispatcher || dispatcher });
    }
    return undiciFetch(input, { ...init, dispatcher: init.dispatcher || dispatcher });
  };
  return true;
}

export function serializeError(error) {
  const serializeCause = (value, depth = 0) => {
    if (!value || depth >= 4) return undefined;
    return {
      name: value.name, message: value.message, code: value.code, errno: value.errno,
      syscall: value.syscall, address: value.address, port: value.port,
      ...(value.cause ? { cause: serializeCause(value.cause, depth + 1) } : {}),
    };
  };
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    ...(error?.status !== undefined ? { status: error.status } : {}),
    ...(error?.providerResponse ? { providerResponse: error.providerResponse } : {}),
    ...(error?.requestAttempts ? { requestAttempts: error.requestAttempts } : {}),
    ...(error?.usage ? { usage: error.usage } : {}),
    ...(error?.unknownCostAttempts ? { unknownCostAttempts: error.unknownCostAttempts } : {}),
    ...(error?.cause ? { cause: serializeCause(error.cause) } : {}),
  };
}
