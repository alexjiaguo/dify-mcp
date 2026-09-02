import { test } from "node:test";
import assert from "node:assert/strict";
import { consoleLogin, csrfValue, extractAuthCookies, isAuthCookie, parseAuthCookiesFromInput, parseCookieJson, parseCookieString, refreshConsoleCookies } from "../src/core/auth.ts";
import { buildCookieHeader, parseSetCookies } from "../src/core/http.ts";
import { ConsoleClient } from "../src/api/console.ts";

// Minimal Response stand-in: apiCall/fetchCapturingCookies only use ok/status/text/getSetCookie.
const mockResponse = (status: number, body: unknown, setCookie?: string[]): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { getSetCookie: () => setCookie ?? [] },
  }) as unknown as Response;

const withFetch = async <T>(impl: (url: unknown, init: { headers?: Record<string, string> }) => Promise<Response>, fn: () => Promise<T>): Promise<T> => {
  const orig = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = impl as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = orig;
  }
};

test("parseCookieString parses k=v pairs and tolerates attributes", () => {
  const c = parseCookieString("console_token=abc; refresh_token=def; Path=/; csrf_token=xyz");
  assert.equal(c.console_token, "abc");
  assert.equal(c.refresh_token, "def");
  assert.equal(c.csrf_token, "xyz");
});

test("buildCookieHeader joins entries with '; '", () => {
  assert.equal(buildCookieHeader({ a: "1", b: "2" }), "a=1; b=2");
  assert.equal(buildCookieHeader({}), "");
});

test("csrfValue finds the csrf cookie case-insensitively", () => {
  assert.equal(csrfValue({ csrf_token: "x" }), "x");
  assert.equal(csrfValue({ __Host_csrf: "y" }), "y");
  assert.equal(csrfValue({ console_token: "z" }), undefined);
});

test("parseSetCookies extracts name=value from Set-Cookie headers", () => {
  const res = mockResponse(200, {}, ["console_token=abc; Path=/; HttpOnly", "csrf_token=xyz; Path=/"]);
  const c = parseSetCookies(res);
  assert.equal(c.console_token, "abc");
  assert.equal(c.csrf_token, "xyz");
});

test("ConsoleClient sends Cookie + X-CSRF-Token when cookies are set (no Bearer)", async () => {
  let captured: { headers?: Record<string, string> } = {};
  await withFetch(
    async (_url, init) => {
      captured = init;
      return mockResponse(200, { data: [] });
    },
    async () => {
      const c = new ConsoleClient("http://x", undefined, { console_token: "t", refresh_token: "r", csrf_token: "c" });
      await c.listProviders();
    },
  );
  assert.equal(captured.headers?.Cookie, "console_token=t; refresh_token=r; csrf_token=c");
  assert.equal(captured.headers?.["X-CSRF-Token"], "c");
  assert.equal(captured.headers?.Authorization, undefined);
});

test("ConsoleClient falls back to Bearer when only a token is set", async () => {
  let captured: { headers?: Record<string, string> } = {};
  await withFetch(
    async (_url, init) => {
      captured = init;
      return mockResponse(200, { data: [] });
    },
    async () => {
      const c = new ConsoleClient("http://x", "tok123");
      await c.listProviders();
    },
  );
  assert.equal(captured.headers?.Authorization, "Bearer tok123");
  assert.equal(captured.headers?.Cookie, undefined);
});

test("ConsoleClient auto-refreshes once on 401 via onRefresh, then retries", async () => {
  let calls = 0;
  let refreshed = false;
  await withFetch(
    async () => {
      calls++;
      return mockResponse(calls === 1 ? 401 : 200, calls === 1 ? { code: "unauthorized", message: "expired" } : { data: [] });
    },
    async () => {
      const c = new ConsoleClient(
        "http://x",
        undefined,
        { console_token: "t", refresh_token: "r", csrf_token: "c" },
        async (ck) => {
          refreshed = true;
          return { ...ck, console_token: "t2" };
        },
      );
      const r = await c.listProviders();
      assert.equal(calls, 2, "should retry exactly once after refresh");
      assert.ok(refreshed, "onRefresh should have been called");
      assert.ok(r.ok, "retry should succeed");
    },
  );
});

test("ConsoleClient does not loop forever: a second 401 after refresh surfaces AUTH_EXPIRED", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return mockResponse(401, { code: "unauthorized", message: "expired" });
    },
    async () => {
      const c = new ConsoleClient(
        "http://x",
        undefined,
        { console_token: "t", refresh_token: "r", csrf_token: "c" },
        async (ck) => ({ ...ck, console_token: "t2" }),
      );
      const r = await c.listProviders();
      assert.equal(calls, 2, "one refresh + one retry, no further attempts");
      assert.ok(!r.ok);
      if (!r.ok) assert.equal(r.error.code, "AUTH_EXPIRED");
    },
  );
});

test("consoleLogin captures cookies from Set-Cookie", async () => {
  await withFetch(
    async () => mockResponse(200, { result: "success" }, ["console_token=abc; Path=/", "refresh_token=def; Path=/", "csrf_token=xyz; Path=/"]),
    async () => {
      const r = await consoleLogin("http://x", "a@b.com", "pw");
      assert.ok(r.ok);
      if (r.ok) {
        assert.equal(r.data.console_token, "abc");
        assert.equal(r.data.refresh_token, "def");
        assert.equal(r.data.csrf_token, "xyz");
      }
    },
  );
});

test("consoleLogin optionally base64-encodes the password payload", async () => {
  let body = "";
  await withFetch(
    async (_url, init) => {
      body = String((init as { body?: string }).body ?? "");
      return mockResponse(200, { result: "success" }, ["console_token=abc; Path=/"]);
    },
    async () => {
      const r = await consoleLogin("http://x", "a@b.com", "secret", "base64");
      assert.ok(r.ok);
    },
  );
  assert.equal(JSON.parse(body).password, Buffer.from("secret", "utf8").toString("base64"));
});

test("refreshConsoleCookies merges new cookies onto existing (keeps refresh_token)", async () => {
  await withFetch(
    async () => mockResponse(200, { result: "success" }, ["console_token=newt; Path=/"]),
    async () => {
      const r = await refreshConsoleCookies("http://x", { console_token: "oldt", refresh_token: "r", csrf_token: "c" });
      assert.ok(r.ok);
      if (r.ok) {
        assert.equal(r.data.console_token, "newt");
        assert.equal(r.data.refresh_token, "r");
        assert.equal(r.data.csrf_token, "c");
      }
    },
  );
});

test("parseCookieString splits on ';' only (comma inside a value must not split)", () => {
  const c = parseCookieString("__Host-access_token=eyJ.abc; cookieyes-consent=consentid:x,consent:yes; __Host-csrf_token=eyJ.def");
  assert.equal(Object.keys(c).length, 3);
  assert.equal(c["cookieyes-consent"], "consentid:x,consent:yes");
  assert.equal(c["__Host-access_token"], "eyJ.abc");
});

test("parseCookieJson parses a browser cookie-export JSON array", () => {
  const json = JSON.stringify([
    { name: "AMP_x", value: "analytics", domain: ".dify.ai" },
    { name: "__Host-access_token", value: "acc", httpOnly: true },
    { name: "__Host-refresh_token", value: "ref" },
  ]);
  const c = parseCookieJson(json);
  assert.equal(c["AMP_x"], "analytics");
  assert.equal(c["__Host-access_token"], "acc");
  assert.equal(c["__Host-refresh_token"], "ref");
});

test("isAuthCookie matches __Host- / __Secure- prefixed auth cookies", () => {
  assert.ok(isAuthCookie("__Host-access_token"));
  assert.ok(isAuthCookie("__Host-csrf_token"));
  assert.ok(isAuthCookie("__Host-refresh_token"));
  assert.ok(isAuthCookie("console_token"));
  assert.ok(isAuthCookie("csrf_token"));
  assert.ok(!isAuthCookie("AMP_83d4855862"));
  assert.ok(!isAuthCookie("cookieyes-consent"));
});

test("extractAuthCookies keeps only auth cookies, drops analytics/consent", () => {
  const all = {
    AMP_83d4855862: "x",
    cookieyesConsent: "y",
    "__Host-access_token": "acc",
    "__Host-csrf_token": "csrf",
    "__Host-refresh_token": "ref",
  };
  const auth = extractAuthCookies(all);
  assert.deepEqual(Object.keys(auth).sort(), ["__Host-access_token", "__Host-csrf_token", "__Host-refresh_token"]);
});

test("parseAuthCookiesFromInput handles JSON array, Cookie header, and object wrapper", () => {
  const json = JSON.stringify([
    { name: "AMP_x", value: "a" },
    { name: "__Host-access_token", value: "acc" },
    { name: "__Host-csrf_token", value: "csrf" },
    { name: "__Host-refresh_token", value: "ref" },
  ]);
  const fromJson = parseAuthCookiesFromInput(json);
  assert.equal(Object.keys(fromJson).length, 3);

  const header = "AMP_x=a; __Host-access_token=acc; __Host-csrf_token=csrf; __Host-refresh_token=ref";
  const fromHeader = parseAuthCookiesFromInput(header);
  assert.deepEqual(Object.keys(fromHeader).sort(), ["__Host-access_token", "__Host-csrf_token", "__Host-refresh_token"]);

  const fromObject = parseAuthCookiesFromInput({
    cookies: [
      { name: "__Host-access_token", value: "acc" },
      { name: "__Host-csrf_token", value: "csrf" },
    ],
  });
  assert.equal(fromObject["__Host-access_token"], "acc");
});
