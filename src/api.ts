import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

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

async function readTaskTitle(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<string | undefined> {
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

  return title;
}

export function createApi() {
  const tasks = new Map<number, Task>();
  let nextTaskId = 1;

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
        const task = { id: nextTaskId++, title };
        tasks.set(task.id, task);
        sendJson(response, 201, task, { Location: `/tasks/${task.id}` });
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
    const path = request.url?.split("?", 1)[0];
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
