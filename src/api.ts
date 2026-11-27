import { TextDecoder } from "node:util";
import { TaskIdempotency } from "./idempotency.js";
import { randomUUID } from "node:crypto";
import { pipeline, Readable } from "node:stream";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URLSearchParams } from "node:url";

import { openTaskDatabase, TaskStore } from "./task-store.js";
import type { Task } from "./task-store.js";

const maxBodyBytes = 4096;
const maxBatchBodyBytes = 32 * 1024;
const maxBatchItems = 50;

function* taskExportLines(tasks: readonly Task[]): Generator<string> {
  for (const task of tasks) {
    yield JSON.stringify(task) + "\n";
  }
}

function exportTasks(request: IncomingMessage, response: ServerResponse, tasks: Iterable<Task>): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed" }, { Allow: "GET, HEAD" });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Content-Disposition": 'attachment; filename="tasks.ndjson"',
    "Cache-Control": "no-store",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  // Snapshot the list before streaming so later requests cannot change this export.
  const lines = Readable.from(taskExportLines([...tasks]), { objectMode: false });
  pipeline(lines, response, () => {
    // Pipeline closes the streams on errors, including client disconnects.
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function acceptsJson(
  request: IncomingMessage,
  response: ServerResponse,
  expected: "application/json" | "application/x-ndjson" = "application/json",
): boolean {
  const mediaType = request.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== expected) {
    sendJson(response, 415, { error: `Content-Type must be ${expected}` });
    return false;
  }

  return true;
}

function isValidIdempotencyKey(key: string | string[]): key is string {
  return typeof key === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(key);
}

async function readBody(
  request: IncomingMessage,
  response: ServerResponse,
  maxBytes: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) {
      sendJson(response, 413, { error: `Request body exceeds ${maxBytes} bytes` }, { Connection: "close" });
      return;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
  maxBytes: number,
): Promise<unknown> {
  const body = await readBody(request, response, maxBytes);
  if (body === undefined) {
    return;
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    sendJson(response, 400, { error: "Invalid JSON" });
    return;
  }
}

async function readNdjsonBody(request: IncomingMessage, response: ServerResponse): Promise<unknown[] | undefined> {
  const body = await readBody(request, response, maxBatchBodyBytes);
  if (body === undefined) {
    return;
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    sendJson(response, 400, { error: "NDJSON must use valid UTF-8" });
    return;
  }

  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length < 1 || lines.length > maxBatchItems) {
    sendJson(response, 400, { error: "tasks must contain 1 to 50 items" });
    return;
  }

  const items: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      items.push(JSON.parse(line));
    } catch {
      sendJson(response, 400, { error: "Invalid NDJSON", index });
      return;
    }
  }
  return items;
}

function taskTitle(data: unknown): string | undefined {
  const rawTitle =
    typeof data === "object" && data !== null && "title" in data ? data.title : undefined;
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
  return title.length > 0 && [...title].length <= 120 ? title : undefined;
}

async function createTask(
  request: IncomingMessage,
  response: ServerResponse,
  tasks: TaskStore,
  idempotency: TaskIdempotency<Task>,
): Promise<void> {
  if (!acceptsJson(request, response)) {
    return;
  }

  const key = request.headers["idempotency-key"];
  if (key !== undefined && !isValidIdempotencyKey(key)) {
    sendJson(response, 400, { error: "Invalid Idempotency-Key" });
    return;
  }

  const data = await readJsonBody(request, response, maxBodyBytes);
  if (data === undefined) {
    return;
  }
  const title = taskTitle(data);
  if (title === undefined) {
    sendJson(response, 400, { error: "title must contain 1 to 120 characters" });
    return;
  }

  const registerTask = () => tasks.create(title);

  if (key === undefined) {
    sendJson(response, 201, registerTask());
    return;
  }

  const result = idempotency.create(key, title, registerTask);
  if (result.status === "conflict") {
    sendJson(response, 409, { error: "Idempotency-Key was already used for another title" });
    return;
  }
  if (result.status === "full") {
    sendJson(response, 503, { error: "Idempotency-Key capacity reached" });
    return;
  }
  sendJson(response, 201, result.value, { "Idempotency-Replayed": String(result.status === "replayed") });
}

async function createTaskBatch(
  request: IncomingMessage,
  response: ServerResponse,
  registerTasks: (titles: string[]) => Task[],
  idempotency: TaskIdempotency<Task[]>,
  format: "json" | "ndjson",
): Promise<void> {
  const importing = format === "ndjson";
  if (!acceptsJson(request, response, importing ? "application/x-ndjson" : "application/json")) {
    return;
  }
  const key = request.headers["idempotency-key"];
  if (key !== undefined && !isValidIdempotencyKey(key)) {
    sendJson(response, 400, { error: "Invalid Idempotency-Key" });
    return;
  }

  const data = importing
    ? await readNdjsonBody(request, response)
    : await readJsonBody(request, response, maxBatchBodyBytes);
  if (data === undefined) {
    return;
  }
  const items = importing ? data
    : typeof data === "object" && data !== null && "tasks" in data ? data.tasks : undefined;
  if (!Array.isArray(items) || items.length < 1 || items.length > maxBatchItems) {
    sendJson(response, 400, { error: "tasks must contain 1 to 50 items" });
    return;
  }

  const titles: string[] = [];
  for (const [index, item] of items.entries()) {
    const title = taskTitle(item);
    if (title === undefined) {
      sendJson(response, 400, { error: "title must contain 1 to 120 characters", index });
      return;
    }
    titles.push(title);
  }

  if (key === undefined) {
    sendJson(response, 201, { tasks: registerTasks(titles) });
    return;
  }
  const result = idempotency.create(key, JSON.stringify(titles), () => registerTasks(titles));
  if (result.status === "conflict") {
    sendJson(response, 409, { error: "Idempotency-Key was already used for another batch" });
    return;
  }
  if (result.status === "full") {
    sendJson(response, 503, { error: "Idempotency-Key capacity reached" });
    return;
  }
  sendJson(response, 201, { tasks: result.value }, { "Idempotency-Replayed": String(result.status === "replayed") });
}

function parseInteger(value: string | null, fallback: number): number {
  if (value === null) {
    return fallback;
  }
  return /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN;
}

function searchTasks(query: string, response: ServerResponse, tasks: Iterable<Task>): void {
  const params = new URLSearchParams(query);
  if (["q", "limit", "after"].some((name) => params.getAll(name).length > 1)) {
    sendJson(response, 400, { error: "q, limit, and after may each appear only once" });
    return;
  }

  const rawQuery = params.get("q");
  const term = rawQuery?.trim().normalize("NFC").toLowerCase();
  if (term !== undefined && (term.length === 0 || [...term].length > 120)) {
    sendJson(response, 400, { error: "q must contain 1 to 120 characters" });
    return;
  }

  const limit = parseInteger(params.get("limit"), 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    sendJson(response, 400, { error: "limit must be an integer from 1 to 100" });
    return;
  }

  const after = parseInteger(params.get("after"), 0);
  if (!Number.isSafeInteger(after)) {
    sendJson(response, 400, { error: "after must be a non-negative safe integer" });
    return;
  }

  const matches: Task[] = [];
  for (const task of tasks) {
    if (task.id <= after || (term !== undefined && !task.title.normalize("NFC").toLowerCase().includes(term))) {
      continue;
    }
    if (matches.length === limit) {
      sendJson(response, 200, { tasks: matches, nextAfter: matches.at(-1)?.id });
      return;
    }
    matches.push(task);
  }
  sendJson(response, 200, { tasks: matches, nextAfter: null });
}

export function createApi(databasePath = ":memory:") {
  const database = openTaskDatabase(databasePath);
  const tasks = new TaskStore(database);
  const idempotency = new TaskIdempotency<Task>(database, "single");
  const importIdempotency = new TaskIdempotency<Task[]>(database, "import");
  const batchIdempotency = new TaskIdempotency<Task[]>(database, "batch");

  function registerBatch(titles: string[]): Task[] {
    return tasks.createBatch(titles);
  }

  function handleRequest(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader("X-Request-ID", randomUUID());
    const path = request.url?.split("?", 1)[0];
    if (path === "/tasks/search") {
      if (request.method === "GET") {
        searchTasks(request.url?.slice(path.length) ?? "", response, tasks.values());
      } else {
        sendJson(response, 405, { error: "Method not allowed" }, { Allow: "GET" });
      }
      return;
    }

    if (path === "/health") {
      if (request.method === "GET") {
        sendJson(response, 200, { status: "ok" });
      } else {
        sendJson(response, 405, { error: "Method not allowed" }, { Allow: "GET" });
      }
      return;
    }

    if (path === "/tasks/batch" || path === "/tasks/import") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "Method not allowed" }, { Allow: "POST" });
        return;
      }
      const importing = path === "/tasks/import";
      const store = importing ? importIdempotency : batchIdempotency;
      void createTaskBatch(request, response, registerBatch, store, importing ? "ndjson" : "json").catch(() => {
        if (!response.destroyed && !response.headersSent) {
          sendJson(response, 500, { error: "Internal server error" });
        }
      });
      return;
    }

    if (path === "/tasks/export") {
      exportTasks(request, response, tasks.values());
      return;
    }

    if (path === "/tasks") {
      if (request.method === "GET") {
        sendJson(response, 200, { tasks: tasks.values() });
      } else if (request.method === "POST") {
        void createTask(request, response, tasks, idempotency).catch(() => {
          if (!response.destroyed && !response.headersSent) {
            sendJson(response, 500, { error: "Internal server error" });
          }
        });
      } else {
        sendJson(response, 405, { error: "Method not allowed" }, { Allow: "GET, POST" });
      }
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  }

  const server = createServer((request, response) => {
    try {
      handleRequest(request, response);
    } catch {
      if (!response.destroyed && !response.headersSent) {
        sendJson(response, 500, { error: "Internal server error" });
      } else {
        response.destroy();
      }
    }
  });
  server.once("close", () => database.close());
  return server;
}
