import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { createApi } from "./api.js";

const configuredPort = process.env.PORT ?? "3000";
const port = Number(configuredPort);
if (configuredPort.trim() === "" || !Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT must be an integer between 0 and 65535");
}

const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? "10000");
if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 60000) {
  throw new Error("SHUTDOWN_TIMEOUT_MS must be an integer between 1 and 60000");
}

const databasePath = process.env.TASK_DB_PATH ?? ":memory:";
const server = createApi(databasePath);
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down`);

  const deadline = setTimeout(() => {
    console.error("Shutdown timed out; closing active connections");
    process.exitCode = 1;
    server.closeAllConnections();
  }, shutdownTimeoutMs);
  deadline.unref();

  server.close((error) => {
    clearTimeout(deadline);
    if (error) {
      console.error("Failed to close API server:", error.message);
      process.exitCode = 1;
    }
  });
}

server.prependListener("request", (request, response) => {
  const started = performance.now();
  response.once("close", () => {
    console.log(JSON.stringify({
      event: "http_request",
      requestId: response.getHeader("X-Request-ID"),
      method: request.method,
      status: response.headersSent ? response.statusCode : null,
      durationMs: Math.round(performance.now() - started),
      outcome: response.writableFinished ? "completed" : "aborted",
    }));
  });
});

server.on("request", (_request, response) => {
  response.once("finish", () => {
    if (shuttingDown) {
      // A connection that was busy during server.close() can now be closed.
      server.closeIdleConnections();
    }
  });
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(port, "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  console.log(`API listening at http://127.0.0.1:${address.port}`);
});
