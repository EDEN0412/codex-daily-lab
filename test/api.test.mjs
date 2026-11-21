import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, beforeEach, test } from "node:test";
import { createApi } from "../dist/api.js";

let server;
let baseUrl;

beforeEach(async () => {
  server = createApi().listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await server[Symbol.asyncDispose]();
});

function postTask(body, contentType = "application/json") {
  return fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

test("GET /health returns the service status", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json\b/);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("GET /tasks/export streams one UTF-8 JSON record per line in task order", async () => {
  const tasks = [
    { id: 1, title: '仕様を確認 📋\n"レビュー"' },
    { id: 2, title: "Ship the update" },
  ];
  for (const { title } of tasks) {
    const created = await postTask(JSON.stringify({ title }));
    assert.equal(created.status, 201);
    await created.json();
  }

  const response = await fetch(baseUrl + "/tasks/export");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="tasks.ndjson"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  const lines = (await response.text()).split("\n");
  assert.equal(lines.pop(), "");
  assert.deepEqual(lines.map((line) => JSON.parse(line)), tasks);
});

test("task export returns an empty file when there are no tasks", async () => {
  const response = await fetch(baseUrl + "/tasks/export");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
});

test("HEAD /tasks/export returns the download headers without a body", async () => {
  await (await postTask('{"title":"Run checks"}')).json();
  const response = await fetch(baseUrl + "/tasks/export", { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="tasks.ndjson"');
  assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  assert.equal(await response.text(), "");
});

test("task export rejects writes and advertises GET and HEAD", async () => {
  const response = await fetch(baseUrl + "/tasks/export", { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
  assert.deepEqual(await response.json(), { error: "Method not allowed" });
});

test("GET /tasks starts with an empty list", async () => {
  const response = await fetch(`${baseUrl}/tasks`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { tasks: [] });
});

test("POST /tasks trims the title, assigns an ID, and adds the task to the list", async () => {
  const first = await postTask('{"title":"  Run the tests  "}', "application/json; charset=utf-8");
  const second = await postTask('{"title":"Review changes"}');
  const list = await fetch(`${baseUrl}/tasks`);

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(list.status, 200);
  const tasks = [
    { id: 1, title: "Run the tests" },
    { id: 2, title: "Review changes" },
  ];
  assert.deepEqual(await first.json(), tasks[0]);
  assert.deepEqual(await second.json(), tasks[1]);
  assert.deepEqual(await list.json(), { tasks });
});

test("POST /tasks rejects malformed JSON", async () => {
  const response = await postTask("{");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid JSON" });
});

test("POST /tasks rejects missing, blank, non-string and long titles", async () => {
  for (const data of [null, {}, { title: " " }, { title: 42 }, { title: "a".repeat(121) }]) {
    const response = await postTask(JSON.stringify(data));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "title must contain 1 to 120 characters" });
  }
  const list = await fetch(`${baseUrl}/tasks`);
  assert.deepEqual(await list.json(), { tasks: [] });
});

test("POST /tasks accepts a title with 120 Unicode code points", async () => {
  const title = "📋".repeat(120);
  const response = await postTask(JSON.stringify({ title }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: 1, title });
});

test("POST /tasks requires application/json", async () => {
  const response = await postTask('{"title":"Review changes"}', "text/plain");
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "Content-Type must be application/json" });
});

test("POST /tasks rejects requests over the body size limit", async () => {
  const response = await postTask(JSON.stringify({ title: "あ".repeat(1500) }));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Request body exceeds 4096 bytes" });
});

test("unknown routes return 404", async () => {
  const response = await fetch(`${baseUrl}/missing`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
});

test("unsupported methods return 405 and describe the allowed methods", async () => {
  for (const [path, allowed] of [["/health", "GET"], ["/tasks", "GET, POST"]]) {
    const response = await fetch(`${baseUrl}${path}`, { method: "PATCH" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), allowed);
    assert.deepEqual(await response.json(), { error: "Method not allowed" });
  }
});
