import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { test } from "node:test";
import { createApi } from "../dist/api.js";

async function setup(t) {
  const server = createApi().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server[Symbol.asyncDispose]());
  const url = `http://127.0.0.1:${server.address().port}/tasks`;
  return {
    url,
    importTasks: (body, headers = {}) => fetch(url + "/import", {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", ...headers },
      body,
    }),
    list: async () => (await fetch(url)).json(),
  };
}

test("an exported NDJSON file can be imported with new unique IDs", async (t) => {
  const { url, importTasks, list } = await setup(t);
  const titles = ["確認 📋", 'A task with a newline\nand "quotes"'];
  for (const title of titles) {
    const created = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    assert.equal(created.status, 201);
    await created.json();
  }
  const exported = await (await fetch(url + "/export")).text();
  const imported = await importTasks(exported);
  const expected = titles.map((title, i) => ({ id: i + 3, title }));
  assert.equal(imported.status, 201);
  assert.deepEqual(await imported.json(), { tasks: expected });
  assert.deepEqual(await list(), {
    tasks: [...titles.map((title, i) => ({ id: i + 1, title })), ...expected],
  });
});

test("NDJSON import accepts CRLF and a missing final newline, ignoring imported IDs", async (t) => {
  const { importTasks } = await setup(t);
  const response = await importTasks('{"id":99,"title":"  First  "}\r\n{"id":99,"title":"Second"}');
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    tasks: [{ id: 1, title: "First" }, { id: 2, title: "Second" }],
  });
});

test("NDJSON import reports the invalid line and saves no partial results", async (t) => {
  const { importTasks, list } = await setup(t);
  const first = '{"title":"Valid"}\n';
  for (const [line, error] of [
    ["invalid JSON", "Invalid NDJSON"],
    ['{"title":" "}', "title must contain 1 to 120 characters"],
    ["null", "title must contain 1 to 120 characters"],
    ["", "Invalid NDJSON"],
  ]) {
    const response = await importTasks(first + line + "\n");
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error, index: 1 });
    assert.deepEqual(await list(), { tasks: [] });
  }
});

test("NDJSON import validates media type, UTF-8, number of records, body size and method", async (t) => {
  const { importTasks, list, url } = await setup(t);
  const record = '{"title":"Valid"}\n';
  const requests = [
    [record, { "Content-Type": "application/json" }, 415],
    ["", {}, 400],
    [record.repeat(51), {}, 400],
    ["x".repeat(32 * 1024 + 1), {}, 413],
    [Buffer.from([0xff]), {}, 400],
  ];
  for (const [body, headers, status] of requests) {
    const response = await importTasks(body, headers);
    assert.equal(response.status, status);
    await response.json();
  }
  const get = await fetch(url + "/import");
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  await get.json();
  assert.deepEqual(await list(), { tasks: [] });
});

test("NDJSON imports replay matching retries using an independent idempotency key scope", async (t) => {
  const { importTasks, list, url } = await setup(t);
  const headers = { "Idempotency-Key": "shared-key" };
  const batch = await fetch(url + "/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: '{"tasks":[{"title":"Batch"}]}',
  });
  assert.equal(batch.status, 201);
  await batch.json();

  const imports = await Promise.all([
    importTasks('{"title":"Import"}\n', headers),
    importTasks('{"id":90,"title":" Import "}', headers),
  ]);
  assert.deepEqual(imports.map((r) => r.headers.get("idempotency-replayed")).sort(), ["false", "true"]);
  for (const result of imports) {
    assert.equal(result.status, 201);
    assert.deepEqual(await result.json(), { tasks: [{ id: 2, title: "Import" }] });
  }
  const conflict = await importTasks('{"title":"Different"}', headers);
  assert.equal(conflict.status, 409);
  await conflict.json();
  assert.deepEqual(await list(), { tasks: [{ id: 1, title: "Batch" }, { id: 2, title: "Import" }] });
});
