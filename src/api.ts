import { TextDecoder } from "node:util";
import { TaskIdempotency } from "./idempotency.js";
import { randomUUID } from "node:crypto";
import { pipeline, Readable } from "node:stream";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

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

async function readTaskTitle(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<string | undefined> {
  if (!acceptsJson(request, response)) {
    return;
  }

  const key = request.headers["idempotency-key"];
  if (request.method === "POST" && key !== undefined && !isValidIdempotencyKey(key)) {
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

  return title;
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

export function createApi(databasePath = ":memory:") {
  const database = openTaskDatabase(databasePath);
  const tasks = new TaskStore(database);
  const idempotency = new TaskIdempotency<Task>(database, "single");
  const importIdempotency = new TaskIdempotency<Task[]>(database, "import");
  const batchIdempotency = new TaskIdempotency<Task[]>(database, "batch");

  function registerBatch(titles: string[]): Task[] {
    return tasks.createBatch(titles);
  }

  async function saveTask(
    request: IncomingMessage,
    response: ServerResponse,
    id?: number,
  ): Promise<void> {
    try {
      const title = await readTaskTitle(request, response);
      if (title === undefined) {
        return;
      }

      if (id === undefined) {
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") {
          const task = tasks.create(title);
          sendJson(response, 201, task, { Location: `/tasks/${task.id}` });
          return;
        }

        const result = idempotency.create(key, title, () => tasks.create(title));
        if (result.status === "conflict") {
          sendJson(response, 409, { error: "Idempotency-Key was already used for another title" });
          return;
        }
        if (result.status === "full") {
          sendJson(response, 503, { error: "Idempotency-Key capacity reached" });
          return;
        }
        sendJson(response, 201, result.value, {
          Location: `/tasks/${result.value.id}`,
          "Idempotency-Replayed": String(result.status === "replayed"),
        });
      } else {
        const updated = tasks.update(id, title);
        if (updated) {
          sendJson(response, 200, updated);
        } else {
          sendJson(response, 404, { error: "Not found" });
        }
      }
    } catch {
      if (!response.destroyed && !response.headersSent) {
        sendJson(response, 500, { error: "Internal server error" });
      }
    }
  }

  function handleRequest(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader("X-Request-ID", randomUUID());
    const path = request.url?.split("?", 1)[0];
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
        void saveTask(request, response);
      } else {
        sendJson(response, 405, { error: "Method not allowed" }, { Allow: "GET, POST" });
      }
      return;
    }

    const taskPath = path?.match(/^\/tasks\/([1-9][0-9]*)$/);
    if (taskPath) {
      const id = Number(taskPath[1]);
      const task = tasks.get(id);
      switch (request.method) {
        case "GET":
          if (task) {
            sendJson(response, 200, task);
            return;
          }
          break;
        case "PATCH":
          if (task) {
            void saveTask(request, response, id);
            return;
          }
          break;
        case "DELETE":
          if (tasks.delete(id)) {
            response.writeHead(204).end();
            return;
          }
          break;
        default:
          sendJson(response, 405, { error: "Method not allowed" }, { Allow: "GET, PATCH, DELETE" });
          return;
      }
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
