import type { DatabaseSync } from "node:sqlite";

const keyLifetimeMs = 10 * 60 * 1_000;
const maxKeys = 1_000;

type Result<T> =
  | { status: "created" | "replayed"; value: T }
  | { status: "conflict" }
  | { status: "full" };

export class TaskIdempotency<T> {
  constructor(
    private readonly database: DatabaseSync,
    private readonly scope: string,
  ) {}

  create(key: string, title: string, createTask: () => T, now = Date.now()): Result<T> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.createOrReplay(key, title, createTask, now);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  private createOrReplay(key: string, title: string, createTask: () => T, now: number): Result<T> {
    this.database.prepare("DELETE FROM task_idempotency WHERE expires_at <= ?").run(now);
    const fingerprint = JSON.stringify(title);
    const existing = this.database.prepare(
      "SELECT fingerprint, response_json FROM task_idempotency WHERE scope = ? AND key = ?",
    ).get(this.scope, key);
    if (existing) {
      return existing.fingerprint === fingerprint
        ? { status: "replayed", value: JSON.parse(existing.response_json as string) as T }
        : { status: "conflict" };
    }

    const count = this.database.prepare(
      "SELECT COUNT(*) AS count FROM task_idempotency WHERE scope = ?",
    ).get(this.scope);
    if (Number(count?.count) >= maxKeys) {
      return { status: "full" };
    }

    const value = createTask();
    this.database.prepare(
      "INSERT INTO task_idempotency (scope, key, fingerprint, response_json, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(this.scope, key, fingerprint, JSON.stringify(value), now + keyLifetimeMs);
    return { status: "created", value };
  }
}
