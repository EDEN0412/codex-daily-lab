import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApi } from "../dist/api.js";
import { TaskIdempotency } from "../dist/idempotency.js";
import { openTaskDatabase } from "../dist/task-store.js";

async function setup(t) {
  const server = createApi().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server[Symbol.asyncDispose]());
  const url = `http://127.0.0.1:${server.address().port}/tasks`;
  return {
    post: (title, key) => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ title }),
    }),
    list: async () => (await fetch(url)).json(),
  };
}

test("concurrent retries with a shared key create exactly one task", async (t) => {
  const { post, list } = await setup(t);
  const responses = await Promise.all([
    post("  One task  ", "retry-1"),
    post("One task", "retry-1"),
    post("One task", "retry-1"),
  ]);
  const expected = { id: 1, title: "One task" };
  for (const response of responses) {
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), expected);
  }
  assert.deepEqual(responses.map((r) => r.headers.get("idempotency-replayed")).sort(),
    ["false", "true", "true"]);
  assert.deepEqual(await list(), { tasks: [expected] });
});

test("reusing a key for a different title returns 409", async (t) => {
  const { post, list } = await setup(t);
  assert.equal((await post("First", "same-key")).status, 201);
  assert.equal((await post("Second", "same-key")).status, 409);
  assert.equal((await post("Second", "other-key")).status, 201);
  assert.deepEqual(await list(), { tasks: [{ id: 1, title: "First" }, { id: 2, title: "Second" }] });
});

test("invalid keys and invalid titles do not reserve a key or create a task", async (t) => {
  const { post, list } = await setup(t);
  for (const key of ["", "has space", "one,two", "a".repeat(129)]) {
    const response = await post("Valid title", key);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid Idempotency-Key" });
  }
  assert.equal((await post(" ", "usable-key")).status, 400);
  assert.equal((await post("Valid title", "usable-key")).status, 201);
  assert.deepEqual(await list(), { tasks: [{ id: 1, title: "Valid title" }] });
});

test("the bounded cache preserves live retries, expires old keys, and then admits new ones", (t) => {
  const database = openTaskDatabase(":memory:");
  t.after(() => database.close());
  const store = new TaskIdempotency(database, "single");
  const createTask = () => ({ id: 1, title: "First" });
  const unexpectedCreation = () => assert.fail("must not create while key is live or cache is full");
  for (let i = 0; i < 1_000; i++) {
    assert.equal(store.create(`key-${i}`, "First", createTask, 0).status, "created");
  }
  assert.equal(store.create("extra", "First", unexpectedCreation, 599_999).status, "full");
  assert.equal(store.create("key-0", "First", unexpectedCreation, 599_999).status, "replayed");
  assert.equal(store.create("key-0", "Changed", unexpectedCreation, 599_999).status, "conflict");
  assert.equal(store.create("extra", "First", createTask, 600_000).status, "created");
  assert.equal(store.create("key-0", "First", createTask, 600_000).status, "created");
});

test("replaying a previously deleted task does not restore it or reuse its ID", async (t) => {
  const server = createApi().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server[Symbol.asyncDispose]());
  const url = `http://127.0.0.1:${server.address().port}/tasks`;
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "deleted-task" },
    body: JSON.stringify({ title: "Original" }),
  };
  const first = await fetch(url, options);
  assert.equal(first.headers.get("location"), "/tasks/1");
  assert.deepEqual(await first.json(), { id: 1, title: "Original" });
  assert.equal((await fetch(url + "/1", { method: "DELETE" })).status, 204);

  const retry = await fetch(url, options);
  assert.equal(retry.headers.get("idempotency-replayed"), "true");
  assert.equal(retry.headers.get("location"), "/tasks/1");
  assert.deepEqual(await retry.json(), { id: 1, title: "Original" });
  assert.deepEqual(await (await fetch(url)).json(), { tasks: [] });

  const next = await fetch(url, { ...options, headers: { ...options.headers, "Idempotency-Key": "new-task" } });
  assert.deepEqual(await next.json(), { id: 2, title: "Original" });
});
