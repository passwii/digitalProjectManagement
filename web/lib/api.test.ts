import assert from "node:assert/strict";
import test from "node:test";

const browserGlobals = ["window", "document", "localStorage", "fetch"];

function installBrowser(pathname = "/login") {
  const assigned = [];
  const removed = [];
  const cookieWrites = [];
  const originals = new Map(
    browserGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );

  globalThis.window = {
    location: {
      pathname,
      origin: "http://localhost:3000",
      protocol: "http:",
      assign(url) {
        assigned.push(url);
      },
    },
    setTimeout,
    clearTimeout,
  };
  globalThis.document = {
    cookie: "",
    set cookie(value) {
      cookieWrites.push(value);
    },
    get cookie() {
      return "";
    },
  };
  globalThis.localStorage = {
    removeItem(key) {
      removed.push(key);
    },
  };

  return {
    assigned,
    cookieWrites,
    removed,
    restore() {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("bad credentials display the backend detail without clearing session or navigating", async (t) => {
  const browser = installBrowser("/login");
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ detail: "用户名或密码错误" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(browser.restore);

  const { authApi, errText } = await import("./api");
  let error: unknown;
  try {
    await authApi.login("admin", "wrong");
  } catch (e) {
    error = e;
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(errText(error), "用户名或密码错误");
  assert.equal(calls.length, 1);
  assert.deepEqual(browser.removed, []);
  assert.deepEqual(browser.cookieWrites, []);
  assert.deepEqual(browser.assigned, []);
});

test("concurrent protected 401s share one refresh and retry each request once", async (t) => {
  const browser = installBrowser("/dashboard");
  const calls = [];
  const protectedCalls = new Map();
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });

  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    calls.push({ url: value, init });
    if (value.endsWith("/auth/refresh")) {
      await refreshGate;
      return jsonResponse({}, 200);
    }
    const count = (protectedCalls.get(value) ?? 0) + 1;
    protectedCalls.set(value, count);
    return count === 1
      ? jsonResponse({ detail: "expired" }, 401)
      : jsonResponse({ value: value.endsWith("/one") ? "one" : "two" });
  };
  t.after(browser.restore);

  const { apiGet } = await import("./api");
  const first = apiGet<{ value: string }>("/protected/one");
  const second = apiGet<{ value: string }>("/protected/two");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.filter((call) => call.url.endsWith("/auth/refresh")).length, 1);
  releaseRefresh();

  assert.deepEqual(await Promise.all([first, second]), [{ value: "one" }, { value: "two" }]);
  assert.equal(protectedCalls.get("http://localhost:8001/api/v1/protected/one"), 2);
  assert.equal(protectedCalls.get("http://localhost:8001/api/v1/protected/two"), 2);
  assert.equal(calls.filter((call) => call.url.endsWith("/auth/refresh")).length, 1);
});

test("protected request retries after refresh only once", async (t) => {
  const browser = installBrowser("/dashboard");
  const calls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith("/auth/refresh")) return jsonResponse({}, 200);
    if (value.endsWith("/auth/logout")) return jsonResponse({ ok: true });
    return jsonResponse({ detail: "expired" }, 401);
  };
  t.after(browser.restore);

  const { apiGet, UnauthorizedError } = await import("./api");
  await assert.rejects(
    () => apiGet("/protected"),
    (error: unknown) => error instanceof UnauthorizedError,
  );

  assert.equal(calls.filter((url) => url.endsWith("/protected")).length, 2);
  assert.equal(calls.filter((url) => url.endsWith("/auth/refresh")).length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/auth/logout")).length, 1);
  assert.equal(browser.assigned.length, 1);
  assert.match(browser.assigned[0], /\/login\?reason=expired/);
});

test("refresh failure navigates to login with expired reason without retrying request", async (t) => {
  const browser = installBrowser("/dashboard");
  const calls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith("/auth/refresh")) return jsonResponse({ detail: "expired" }, 401);
    if (value.endsWith("/auth/logout")) return jsonResponse({ ok: true });
    return jsonResponse({ detail: "expired" }, 401);
  };
  t.after(browser.restore);

  const { apiGet, UnauthorizedError } = await import("./api");
  await assert.rejects(
    () => apiGet("/protected"),
    (error: unknown) => error instanceof UnauthorizedError,
  );

  assert.equal(calls.filter((url) => url.endsWith("/protected")).length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/auth/refresh")).length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/auth/logout")).length, 1);
  assert.equal(browser.assigned.length, 1);
  assert.match(browser.assigned[0], /\/login\?reason=expired/);
});

test("FormData replay keeps body and does not set multipart Content-Type", async (t) => {
  const browser = installBrowser("/dashboard");
  const uploadCalls = [];
  let uploadCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/auth/refresh")) return jsonResponse({}, 200);
    if (value.endsWith("/upload")) {
      uploadCount += 1;
      uploadCalls.push(init);
      return uploadCount === 1
        ? jsonResponse({ detail: "expired" }, 401)
        : jsonResponse({ ok: true });
    }
    return jsonResponse({}, 404);
  };
  t.after(browser.restore);

  const { apiUpload } = await import("./api");
  const form = new FormData();
  form.set("file", new Blob(["hello"]), "hello.txt");

  assert.deepEqual(await apiUpload("/upload", form), { ok: true });
  assert.equal(uploadCalls.length, 2);
  assert.equal(uploadCalls[0].body, form);
  assert.equal(uploadCalls[1].body, form);
  assert.equal(new Headers(uploadCalls[0].headers).get("Content-Type"), null);
  assert.equal(new Headers(uploadCalls[1].headers).get("Content-Type"), null);
});

test("clearSession on login removes legacy artifacts without server logout", async (t) => {
  const browser = installBrowser("/login");
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  };
  t.after(browser.restore);

  const { clearSession } = await import("./api");
  await clearSession();

  assert.deepEqual(browser.removed, ["pm_access_token", "pm_refresh_token"]);
  assert.equal(browser.cookieWrites.length, 4);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(browser.assigned, []);
});
