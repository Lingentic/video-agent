import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
const healthSource = source.slice(source.indexOf("async function waitForHealth("), source.indexOf("function serviceUrl("));

function harness(fetch, { stepMs = 0 } = {}) {
  let clock = 0;
  const Date = { now: () => clock };
  const setTimeout = callback => { clock += stepMs; callback(); };
  return Function("fetch", "Date", "setTimeout", `${healthSource}return waitForHealth;`)(fetch, Date, setTimeout);
}

test("local cold startup can take more than ten seconds without changing public tunnel budgets", async () => {
  let calls = 0;
  const wait = harness(async () => {
    if (++calls === 1) throw new Error("connection refused");
    return new Response('{"ok":true}');
  }, { stepMs: 12000 });
  assert.deepEqual(await wait("http://127.0.0.1", "/api/health", 30000), { ok: true });
  assert.equal(calls, 2);
  assert.match(source, /waitForHealth\(`http:\/\/127\.0\.0\.1:\$\{port\}`, definition\.healthPath, 30000, startupController\.signal\)/);
  assert.match(healthSource, /timeoutMs = 10000/);
});

test("an exited child interrupts an in-flight health request with the original error", async () => {
  const controller = new AbortController();
  const failure = new Error("进程退出：code=1, signal=null");
  const wait = harness(async (_url, { signal }) => {
    const pending = new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    controller.abort(failure);
    return pending;
  });
  await assert.rejects(wait("http://127.0.0.1", "/api/health", 30000, controller.signal), error => error === failure);
  assert.match(source, /startupController\.abort\(new Error\(service\.error\)\)/);
});

test("unhealthy services still time out rather than silently becoming ready", async () => {
  const wait = harness(async () => new Response("not ready", { status: 503 }), { stepMs: 10000 });
  await assert.rejects(wait("http://127.0.0.1", "/api/health", 30000), /HTTP 503.*30000ms/);
});

test("intentional shutdown is marked expected and startup errors survive child cleanup", () => {
  assert.match(source, /const expected = stopping \|\| Boolean\(service\.expectedStop\)/);
  assert.match(source, /service\.expectedStop = true;/);
  assert.match(source, /await stopService\(service\);\s+service\.status = "error";\s+service\.error = error\.message;/);
});
