import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URLSearchParams } from "node:url";

interface Task {
  id: number;
  title: string;
}

const maxBodyBytes = 4096;

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

export function createApi() {
  const tasks: Task[] = [];

  return createServer((request, response) => {
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
