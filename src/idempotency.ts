import { performance } from "node:perf_hooks";

const keyLifetimeMs = 10 * 60 * 1_000;
const maxKeys = 1_000;

interface Entry<T> {
  title: string;
  value: T;
  expiresAt: number;
}

type Result<T> =
  | { status: "created" | "replayed"; value: T }
  | { status: "conflict" }
  | { status: "full" };

export class TaskIdempotency<T> {
  private readonly entries = new Map<string, Entry<T>>();

  create(key: string, title: string, createTask: () => T, now = performance.now()): Result<T> {
    // Keep existing keys valid until their expiry, even when the cache is full.
    for (const [storedKey, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(storedKey);
      }
    }

    const existing = this.entries.get(key);
    if (existing) {
      return existing.title === title
        ? { status: "replayed", value: existing.value }
        : { status: "conflict" };
    }

    if (this.entries.size >= maxKeys) {
      return { status: "full" };
    }

    const value = createTask();
    this.entries.set(key, { title, value, expiresAt: now + keyLifetimeMs });
    return { status: "created", value };
  }
}
