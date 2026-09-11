import { test } from "node:test";
import assert from "node:assert/strict";
import { readSse } from "../src/core/http.ts";
import { ConsoleClient } from "../src/api/console.ts";

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("readSse invokes onEvent for each data event", async () => {
  const events: unknown[] = [];
  const restore = mockFetch(() => {
    const body = [
      "data: {\"event\":\"workflow_started\"}\n\n",
      "data: {\"event\":\"node_finished\"}\n\n",
      "data: {\"event\":\"workflow_finished\"}\n\n",
    ].join("");
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  try {
    const result = await readSse("https://dify.example/console/api", "apps/a/workflows/draft/run", {
      body: { inputs: {} },
      onEvent: (event, index) => {
        events.push({ index, event });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(events.length, 3);
    assert.equal((events[0] as { event: { event: string } }).event.event, "workflow_started");
    assert.equal((events[2] as { index: number }).index, 2);
  } finally {
    restore();
  }
});

test("ConsoleClient stream surfaces onEvent from constructor", async () => {
  const messages: string[] = [];
  const restore = mockFetch(() => {
    return new Response("data: {\"event\":\"workflow_started\"}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  try {
    const client = new ConsoleClient(
      "https://dify.example",
      "tok",
      undefined,
      undefined,
      async (event) => {
        if (event && typeof event === "object" && "event" in event) {
          messages.push(String((event as { event: string }).event));
        }
      },
    );
    const result = await client.runDraft("app-1", {});
    assert.equal(result.ok, true);
    assert.deepEqual(messages, ["workflow_started"]);
  } finally {
    restore();
  }
});
