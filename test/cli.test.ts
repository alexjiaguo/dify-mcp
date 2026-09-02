import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFlags, readTextArg, resolveConsoleLoginCredentials } from "../src/cli.ts";

test("parseFlags handles positionals, values, =values, booleans, repeats", () => {
  const { positional, flags } = parseFlags([
    "wf", "run", "app-1",
    "--input", "a=1", "--input", "b=2",
    "--yes", "--graph=test/fixtures/valid.json", "-o", "json",
    "--output-file", "/tmp/difywf-result.json",
  ]);
  assert.deepEqual(positional, ["wf", "run", "app-1"]);
  assert.deepEqual(flags.input, ["a=1", "b=2"]);
  assert.equal(flags.yes, true);
  assert.equal(flags.graph, "test/fixtures/valid.json");
  assert.equal(flags["output-file"], "/tmp/difywf-result.json");
});

test("console login credentials prefer flags and fall back to environment", () => {
  assert.deepEqual(
    resolveConsoleLoginCredentials({}, {
      DIFY_CONSOLE_EMAIL: "bot@example.com",
      DIFY_CONSOLE_PASSWORD: "from-env",
    }),
    { email: "bot@example.com", password: "from-env", passwordEncoding: "plain" },
  );
  assert.deepEqual(
    resolveConsoleLoginCredentials(
      { email: "flag@example.com", password: "from-flags" },
      { DIFY_CONSOLE_EMAIL: "env@example.com", DIFY_CONSOLE_PASSWORD: "from-env" },
    ),
    { email: "flag@example.com", password: "from-flags", passwordEncoding: "plain" },
  );
  assert.equal(
    resolveConsoleLoginCredentials({}, {
      DIFY_CONSOLE_PASSWORD_ENCODING: "base64",
    }).passwordEncoding,
    "base64",
  );
  assert.throws(
    () => resolveConsoleLoginCredentials({}, { DIFY_CONSOLE_PASSWORD_ENCODING: "rot13" }),
    /plain.*base64/,
  );
});

test("output-file carries large structured results outside stdout", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "difywf-output-"));
  const output = path.join(dir, "result.json");
  const stdout = execFileSync(
    process.execPath,
    ["bin/difywf.js", "agent", "guide", "all", "--output", "json", "--output-file", output],
    { encoding: "utf8" },
  );
  const acknowledgement = JSON.parse(stdout);
  const result = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(acknowledgement.ok, true);
  assert.equal(acknowledgement.output_file, output);
  assert.equal(result.ok, true);
  assert.match(result.data, /golden path/i);
});

test("yaml @file carries DSLs larger than the operating-system argument limit", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "difywf-yaml-"));
  const source = path.join(dir, "workflow.yml");
  const yaml = `kind: app\nworkflow:\n  graph:\n    note: ${"x".repeat(200_000)}\n`;
  fs.writeFileSync(source, yaml, "utf8");
  assert.equal(readTextArg(`@${source}`, "yaml"), yaml);
  assert.equal(readTextArg("kind: app\n", "yaml"), "kind: app\n");
  assert.throws(() => readTextArg(`@${source}.missing`, "yaml"), /file not found/);
});
