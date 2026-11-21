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

async function createTask(
  request: IncomingMessage,
  response: ServerResponse,
  tasks: Task[],
): Promise<void> {
  const mediaType = request.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    sendJson(response, 415, { error: "Content-Type must be application/json" });
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      sendJson(response, 413, { error: "Request body exceeds 4096 bytes" }, { Connection: "close" });
      return;
    }
    chunks.push(chunk);
  }

  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendJson(response, 400, { error: "Invalid JSON" });
    return;
  }

  const rawTitle =
    typeof data === "object" && data !== null && "title" in data ? data.title : undefined;
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
  if (title.length === 0 || [...title].length > 120) {
    sendJson(response, 400, { error: "title must contain 1 to 120 characters" });
    return;
  }

  const task = { id: tasks.length + 1, title };
  tasks.push(task);
  sendJson(response, 201, task);
}

export function createApi() {
  const tasks: Task[] = [];

  return createServer((request, response) => {
    const path = request.url?.split("?", 1)[0];
    if (path === "/health") {
      if (request.method === "GET") {
        sendJson(response, 200, { status: "ok" });
      } else {
        sendJson(response, 405, { error: "Method not allowed" }, { Allow: "GET" });
      }
      return;
    }

    if (path === "/tasks/export") {
      exportTasks(request, response, tasks.values());
      return;
    }

    if (path === "/tasks") {
      if (request.method === "GET") {
        sendJson(response, 200, { tasks });
      } else if (request.method === "POST") {
        void createTask(request, response, tasks).catch(() => {
          if (!response.destroyed) {
            sendJson(response, 500, { error: "Internal server error" });
          }
        });
      } else {
        sendJson(response, 405, { error: "Method not allowed" }, { Allow: "GET, POST" });
      }
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  });
}
