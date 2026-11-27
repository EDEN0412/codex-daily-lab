import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createApi } from "../dist/api.js";

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "codex-task-db-"));
  const path = join(directory, "tasks.sqlite");
  const servers = new Set();
  t.after(async () => {
    for (const server of servers) {
      await server[Symbol.asyncDispose]();
    }
    await rm(directory, { recursive: true, force: true });
  });

  async function start() {
    const server = createApi(path).listen(0, "127.0.0.1");
    servers.add(server);
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/tasks`;
    return {
      url,
      async close() {
        await server[Symbol.asyncDispose]();
        servers.delete(server);
      },
      list: async () => (await fetch(url)).json(),
      post: (endpoint, body, key) => fetch(url + endpoint, {
        method: "POST",
        headers: {
          "Content-Type": endpoint === "/import" ? "application/x-ndjson" : "application/json",
          "Idempotency-Key": key,
        },
        body: endpoint === "/import" ? body : JSON.stringify(body),
      }),
    };
  }
  return { path, start };
}

test("file storage retains tasks and all idempotency scopes after restarting the API", async (t) => {
  const { start } = await setup(t);
  const api = await start();
  const title = "確認 📋\u0000\ud800";
  const operations = [
    ["", { title }, { id: 1, title }],
    ["/batch", { tasks: [{ title: "Batch" }] }, { tasks: [{ id: 2, title: "Batch" }] }],
    ["/import", '{"title":"Imported"}\n', { tasks: [{ id: 3, title: "Imported" }] }],
  ];
  for (const [endpoint, body, expected] of operations) {
    const response = await api.post(endpoint, body, "shared-key");
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("idempotency-replayed"), "false");
    assert.deepEqual(await response.json(), expected);
  }
  await api.close();

  const restarted = await start();
  for (const [endpoint, body, expected] of operations) {
    const response = await restarted.post(endpoint, body, "shared-key");
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(await response.json(), expected);
  }

  const next = await restarted.post("", { title: "Next" }, "new-key");
  assert.deepEqual(await next.json(), { id: 4, title: "Next" });
  assert.deepEqual(await restarted.list(), {
    tasks: [{ id: 1, title }, { id: 2, title: "Batch" }, { id: 3, title: "Imported" }, { id: 4, title: "Next" }],
  });
});

test("two API instances sharing a SQLite file cannot register the same key twice", async (t) => {
  const { start } = await setup(t);
  const first = await start();
  const second = await start();
  const responses = await Promise.all([
    first.post("", { title: "Shared task" }, "once"),
    second.post("", { title: "Shared task" }, "once"),
  ]);
  assert.deepEqual(responses.map((r) => r.headers.get("idempotency-replayed")).sort(), ["false", "true"]);
  for (const response of responses) {
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { id: 1, title: "Shared task" });
  }
  assert.deepEqual(await second.list(), { tasks: [{ id: 1, title: "Shared task" }] });
});

test("failed idempotency persistence rolls back every task in a batch", async (t) => {
  const { path, start } = await setup(t);
  const api = await start();
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TRIGGER reject_idempotency_write BEFORE INSERT ON task_idempotency
      BEGIN SELECT RAISE(ABORT, 'test write failure'); END;
    `);
    const body = { tasks: [{ title: "First" }, { title: "Second" }] };
    const failed = await api.post("/batch", body, "retry");
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: "Internal server error" });
    assert.deepEqual(await api.list(), { tasks: [] });

    database.exec("DROP TRIGGER reject_idempotency_write");
    const retry = await api.post("/batch", body, "retry");
    assert.equal(retry.status, 201);
    assert.deepEqual(await retry.json(), { tasks: [{ id: 1, title: "First" }, { id: 2, title: "Second" }] });
  } finally {
    database.close();
  }
});

test("updates and deletions survive reopening the database without reusing IDs", async (t) => {
  const { start } = await setup(t);
  const api = await start();
  assert.equal((await api.post("", { title: "Original" }, "first")).status, 201);
  assert.equal((await api.post("", { title: "Remove" }, "second")).status, 201);
  const update = await fetch(api.url + "/1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: '{"title":"Updated"}',
  });
  assert.equal(update.status, 200);
  assert.deepEqual(await update.json(), { id: 1, title: "Updated" });
  assert.equal((await fetch(api.url + "/2", { method: "DELETE" })).status, 204);
  await api.close();

  const restarted = await start();
  assert.deepEqual(await restarted.list(), { tasks: [{ id: 1, title: "Updated" }] });
  const missing = await fetch(restarted.url + "/2");
  assert.equal(missing.status, 404);
  await missing.json();
  const next = await restarted.post("", { title: "Next" }, "third");
  assert.deepEqual(await next.json(), { id: 3, title: "Next" });
});
