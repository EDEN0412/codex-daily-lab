import { TaskIdempotency } from "./idempotency.js";
import { randomUUID } from "node:crypto";
import { pipeline, Readable } from "node:stream";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

interface Task {
  id: number;
  title: string;
}

const maxBodyBytes = 4096;

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

function acceptsJson(request: IncomingMessage, response: ServerResponse): boolean {
  const mediaType = request.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    sendJson(response, 415, { error: "Content-Type must be application/json" });
    return false;
  }

  return true;
}

function isValidIdempotencyKey(key: string | string[]): key is string {
  return typeof key === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(key);
}

async function readJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
  maxBytes: number,
): Promise<unknown> {
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

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendJson(response, 400, { error: "Invalid JSON" });
    return;
  }
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
): Promise<void> {
  if (!acceptsJson(request, response)) {
    return;
  }
  const key = request.headers["idempotency-key"];
  if (key !== undefined && !isValidIdempotencyKey(key)) {
    sendJson(response, 400, { error: "Invalid Idempotency-Key" });
    return;
  }

  const data = await readJsonBody(request, response, 32 * 1024);
  if (data === undefined) {
    return;
  }
  const items = typeof data === "object" && data !== null && "tasks" in data ? data.tasks : undefined;
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
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

export function createApi() {
  const tasks = new Map<number, Task>();
  const idempotency = new TaskIdempotency<Task>();
  const batchIdempotency = new TaskIdempotency<Task[]>();
  let nextTaskId = 1;

  function registerTask(title: string): Task {
    const task = { id: nextTaskId++, title };
    tasks.set(task.id, task);
    return task;
  }

  function registerBatch(titles: string[]): Task[] {
    return titles.map(registerTask);
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
          const task = registerTask(title);
          sendJson(response, 201, task, { Location: `/tasks/${task.id}` });
          return;
        }

        const result = idempotency.create(key, title, () => registerTask(title));
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
      } else if (tasks.has(id)) {
        const task = { id, title };
        tasks.set(id, task);
        sendJson(response, 200, task);
      } else {
        sendJson(response, 404, { error: "Not found" });
      }
    } catch {
      if (!response.destroyed && !response.headersSent) {
        sendJson(response, 500, { error: "Internal server error" });
      }
    }
  }

  return createServer((request, response) => {
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

    if (path === "/tasks/batch") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "Method not allowed" }, { Allow: "POST" });
        return;
      }
      void createTaskBatch(request, response, registerBatch, batchIdempotency).catch(() => {
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
        sendJson(response, 200, { tasks: [...tasks.values()] });
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
  });
}
