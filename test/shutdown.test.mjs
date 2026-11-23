import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import process from "node:process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";

const entryPoint = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function startServer(t, timeoutMs = 2_000) {
  const child = spawn(process.execPath, [entryPoint], {
    env: { ...process.env, PORT: "0", SHUTDOWN_TIMEOUT_MS: String(timeoutMs) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exit;
    lines.close();
  });

  async function nextLine() {
    return Promise.race([
      once(lines, "line").then(([line]) => line),
      exit.then(() => { throw new Error(`Server exited before producing expected output: ${stderr}`); }),
    ]);
  }

  const [, url] = /^API listening at (http:\/\/127\.0\.0\.1:\d+)$/.exec(await nextLine()) ?? [];
  assert.ok(url);
  return { child, exit, nextLine, url, getErrors: () => stderr };
}

function openTaskRequest(url) {
  const body = JSON.stringify({ title: "Finish before shutdown" });
  const req = request(`${url}/tasks`, {
    method: "POST",
    headers: {
      Expect: "100-continue",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  });
  const continued = once(req, "continue");
  const result = once(req, "response").then(async ([response]) => {
    const chunks = [];
    for await (const chunk of response) {
      chunks.push(chunk);
    }
    return { status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  });
  req.flushHeaders();
  return { continued, result, finish: () => req.end(body) };
}

test("response request IDs correlate with structured logs without exposing request data",
  { timeout: 5_000 }, async (t) => {
    const server = await startServer(t);
    const receivedIds = [];
    for (const path of ["/health", "/missing?token=secret-in-query"]) {
      const logLine = server.nextLine();
      const response = await fetch(server.url + path, {
        headers: { "X-Request-ID": "untrusted-client-id", Authorization: "Bearer secret-in-header" },
      });
      await response.json();

      const requestId = response.headers.get("x-request-id");
      assert.match(requestId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
      receivedIds.push(requestId);
      const line = await logLine;
      const log = JSON.parse(line);
      assert.equal(log.event, "http_request");
      assert.equal(log.requestId, requestId);
      assert.equal(log.method, "GET");
      assert.equal(log.status, response.status);
      assert.equal(log.outcome, "completed");
      assert.ok(Number.isInteger(log.durationMs) && log.durationMs >= 0);
      for (const privateValue of ["secret-in-query", "secret-in-header", "untrusted-client-id"]) {
        assert.equal(line.includes(privateValue), false);
      }
    }
    assert.notEqual(receivedIds[0], receivedIds[1]);
  },
);

test("SIGINT closes an idle API server cleanly", { timeout: 5_000 }, async (t) => {
  const { child, exit, url } = await startServer(t);
  const health = await fetch(url + "/health");
  assert.equal(health.status, 200);
  await health.json();

  assert.equal(child.kill("SIGINT"), true);
  assert.deepEqual(await exit, [0, null]);
});

test("SIGTERM lets an in-flight request complete before a clean exit", { timeout: 5_000 }, async (t) => {
  const server = await startServer(t);
  const task = openTaskRequest(server.url);
  const [response] = await Promise.all([task.result, (async () => {
    await task.continued;
    const stopping = server.nextLine();
    assert.equal(server.child.kill("SIGTERM"), true);
    assert.match(await stopping, /Received SIGTERM, shutting down/);
    task.finish();
  })()]);
  assert.deepEqual(response, {
    status: 201,
    body: { id: 1, title: "Finish before shutdown" },
  });
  assert.deepEqual(await server.exit, [0, null]);
});

test("SIGTERM closes a stuck request when the grace period expires", { timeout: 5_000 }, async (t) => {
  const server = await startServer(t, 150);
  const task = openTaskRequest(server.url);
  const disconnected = assert.rejects(task.result, { code: "ECONNRESET" });
  await task.continued;

  const stopping = server.nextLine();
  assert.equal(server.child.kill("SIGTERM"), true);
  assert.match(await stopping, /Received SIGTERM, shutting down/);
  const abortLog = server.nextLine();
  await disconnected;
  assert.deepEqual(await server.exit, [1, null]);
  const { event, status, outcome } = JSON.parse(await abortLog);
  assert.deepEqual({ event, status, outcome }, {
    event: "http_request", status: null, outcome: "aborted",
  });
  assert.match(server.getErrors(), /Shutdown timed out/);
});
