import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApi } from "../dist/api.js";

async function setup(t) {
  const server = createApi().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server[Symbol.asyncDispose]());
  const tasksUrl = `http://127.0.0.1:${server.address().port}/tasks`;
  const batchUrl = tasksUrl + "/batch";
  return {
    batchUrl,
    tasksUrl,
    post: (body, headers = {}) => fetch(batchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    postSingle: (title) => fetch(tasksUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
    list: async () => (await fetch(tasksUrl)).json(),
  };
}

test("batch creation uses consecutive IDs and the existing task list", async (t) => {
  const { post, postSingle, list } = await setup(t);
  const first = await postSingle("Existing");
  assert.equal(first.status, 201);
  const saved = await first.json();
  const response = await post({ tasks: [{ title: "  確認 📋  " }, { title: "Run checks" }] });
  const created = [{ id: 2, title: "確認 📋" }, { id: 3, title: "Run checks" }];
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { tasks: created });
  assert.deepEqual(await list(), { tasks: [saved, ...created] });
});

test("one invalid task prevents the entire batch from being stored", async (t) => {
  const { post, postSingle, list } = await setup(t);
  const response = await post({ tasks: [{ title: "Valid" }, { title: " " }] });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "title must contain 1 to 120 characters", index: 1 });
  assert.deepEqual(await list(), { tasks: [] });
  assert.deepEqual(await (await postSingle("First saved task")).json(), { id: 1, title: "First saved task" });
});

test("batch validates its size, JSON media type, and HTTP method", async (t) => {
  const { post, list, batchUrl } = await setup(t);
  for (const body of [null, {}, { tasks: [] }, { tasks: Array(51).fill({ title: "Task" }) }]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    await response.json();
  }
  const oversized = await post({ tasks: [{ title: "x".repeat(32 * 1024) }] });
  assert.equal(oversized.status, 413);
  await oversized.json();
  const unsupported = await post({ tasks: [{ title: "Task" }] }, { "Content-Type": "text/plain" });
  assert.equal(unsupported.status, 415);
  await unsupported.json();
  const get = await fetch(batchUrl);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  await get.json();
  assert.deepEqual(await list(), { tasks: [] });
});

test("concurrent retries replay the same ordered batch and conflicting input returns 409", async (t) => {
  const { post, list } = await setup(t);
  const headers = { "Idempotency-Key": "batch-1" };
  const tasks = [{ title: "First" }, { title: "Second" }];
  const responses = await Promise.all([post({ tasks }, headers), post({ tasks }, headers)]);
  assert.deepEqual(responses.map((r) => r.headers.get("idempotency-replayed")).sort(), ["false", "true"]);
  const expected = { tasks: [{ id: 1, title: "First" }, { id: 2, title: "Second" }] };
  for (const response of responses) {
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), expected);
  }

  const conflict = await post({ tasks: tasks.toReversed() }, headers);
  assert.equal(conflict.status, 409);
  await conflict.json();
  assert.deepEqual(await list(), expected);
});

test("batch creation after a deletion does not reuse task IDs", async (t) => {
  const { postSingle, post, list, tasksUrl } = await setup(t);
  const created = await postSingle("Delete this");
  assert.equal(created.status, 201);
  const first = await created.json();
  assert.equal((await fetch(tasksUrl + "/" + first.id, { method: "DELETE" })).status, 204);
  const batch = await post({ tasks: [{ title: "First" }, { title: "Second" }] });
  assert.equal(batch.status, 201);
  const expected = { tasks: [{ id: 2, title: "First" }, { id: 3, title: "Second" }] };
  assert.deepEqual(await batch.json(), expected);
  assert.deepEqual(await list(), expected);
});
