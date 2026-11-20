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

test("task search matches titles across case and Unicode composition", async () => {
  const title = "Review Cafe\u0301 notes";
  await (await postTask(JSON.stringify({ title }))).json();
  await (await postTask('{"title":"Write tests"}')).json();

  const response = await fetch(`${baseUrl}/tasks/search?q=%20CAF%C3%89%20`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { tasks: [{ id: 1, title }], nextAfter: null });
});

test("task search paginates matching tasks by ID without overlap", async () => {
  const titles = ["Review API", "Write docs", "Review CI", "Review tests"];
  for (const title of titles) {
    await (await postTask(JSON.stringify({ title }))).json();
  }
  const searchUrl = `${baseUrl}/tasks/search?q=review&limit=2`;
  const first = await fetch(searchUrl);
  assert.equal(first.status, 200);
  const page = await first.json();
  assert.deepEqual(page, { tasks: [{ id: 1, title: titles[0] }, { id: 3, title: titles[2] }], nextAfter: 3 });

  const second = await fetch(`${searchUrl}&after=${page.nextAfter}`);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { tasks: [{ id: 4, title: titles[3] }], nextAfter: null });
});

test("task search defaults to 20 tasks and handles an empty page", async () => {
  for (let i = 1; i <= 21; i++) {
    await (await postTask(JSON.stringify({ title: `Task ${i}` }))).json();
  }
  const response = await fetch(`${baseUrl}/tasks/search`);
  const page = await response.json();
  assert.equal(response.status, 200);
  assert.equal(page.tasks.length, 20);
  assert.equal(page.nextAfter, 20);

  const empty = await fetch(`${baseUrl}/tasks/search?after=21`);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { tasks: [], nextAfter: null });
});

test("task search rejects invalid and repeated query parameters", async () => {
  const invalid = [
    "q=%20", `q=${"a".repeat(121)}`, "limit=", "limit=0", "limit=101", "limit=1e1",
    "after=-1", "after=1.5", "after=9007199254740992", "after=0&after=1", "q=a&q=b",
  ];
  for (const query of invalid) {
    const response = await fetch(`${baseUrl}/tasks/search?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(typeof (await response.json()).error, "string");
  }
});

test("task search rejects writes and advertises GET", async () => {
  const response = await fetch(`${baseUrl}/tasks/search`, { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.deepEqual(await response.json(), { error: "Method not allowed" });
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
