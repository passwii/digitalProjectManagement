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

test("bad credentials do not clear session or navigate", async (t) => {
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

  const { UnauthorizedError, authApi } = await import("./api");
  await assert.rejects(() => authApi.login("admin", "wrong"), UnauthorizedError);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.deepEqual(browser.assigned, []);
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
