import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, beforeEach, test } from "node:test";
import { URL } from "node:url";
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

test("GET /tasks/:id returns the task at the creation URL", async () => {
  const created = await postTask('{"title":"Review changes"}');
  const location = created.headers.get("location");
  assert.equal(location, "/tasks/1");
  const response = await fetch(new URL(location, baseUrl));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), await created.json());
});

test("PATCH /tasks/:id updates the title while preserving the ID and list order", async () => {
  await (await postTask('{"title":"Draft changes"}')).json();
  await (await postTask('{"title":"Run tests"}')).json();
  const url = new URL("/tasks/1", baseUrl);
  const headers = { "Content-Type": "application/json" };
  const invalid = await fetch(url, { method: "PATCH", headers, body: '{"title":" "}' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "title must contain 1 to 120 characters" });
  assert.deepEqual(await (await fetch(url)).json(), { id: 1, title: "Draft changes" });

  const updated = await fetch(url, { method: "PATCH", headers, body: '{"title":"  Review changes  "}' });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { id: 1, title: "Review changes" });
  assert.deepEqual(await (await fetch(new URL("/tasks", baseUrl))).json(), {
    tasks: [
      { id: 1, title: "Review changes" },
      { id: 2, title: "Run tests" },
    ],
  });
});

test("DELETE /tasks/:id removes the task without reusing its ID", async () => {
  await (await postTask('{"title":"Draft changes"}')).json();
  await (await postTask('{"title":"Review changes"}')).json();
  const url = new URL("/tasks/1", baseUrl);
  const deleted = await fetch(url, { method: "DELETE" });
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), "");
  assert.deepEqual(await (await fetch(new URL("/tasks", baseUrl))).json(), {
    tasks: [{ id: 2, title: "Review changes" }],
  });
  const response = await postTask('{"title":"Run tests"}');
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: 3, title: "Run tests" });

  for (const method of ["GET", "PATCH", "DELETE"]) {
    const missing = await fetch(url, { method });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Not found" });
  }
});

test("task routes distinguish invalid IDs from unsupported methods", async () => {
  await (await postTask('{"title":"Review changes"}')).json();
  for (const path of ["/tasks/0", "/tasks/01", "/tasks/1.5", "/tasks/1/extra"]) {
    const response = await fetch(new URL(path, baseUrl));
    assert.equal(response.status, 404);
    await response.json();
  }
  const response = await fetch(new URL("/tasks/1", baseUrl), { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, PATCH, DELETE");
  assert.deepEqual(await response.json(), { error: "Method not allowed" });
});
