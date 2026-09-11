import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeKeychainBlobForTest } from "../src/core/config.ts";

test("decodeKeychainBlob recovers JSON hex-encoded by security -w", () => {
  const json = '{"active_host":"https://cloud.dify.ai","hosts":{}}';
  const hex = Buffer.from(json, "utf8").toString("hex");
  assert.equal(decodeKeychainBlobForTest(hex), json);
  assert.equal(decodeKeychainBlobForTest(json), json);
});
