import { DatabaseSync } from "node:sqlite";

export interface Task {
  id: number;
  title: string;
}

interface TaskRow {
  id: number;
  title_json: string;
}

function toTask(row: TaskRow): Task {
  return { id: row.id, title: JSON.parse(row.title_json) as string };
}

export function openTaskDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS task_idempotency (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        response_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      ) STRICT;
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export class TaskStore {
  constructor(private readonly database: DatabaseSync) {}

  values(): Task[] {
    const rows = this.database.prepare("SELECT id, title_json FROM tasks ORDER BY id").all();
    return (rows as unknown as TaskRow[]).map(toTask);
  }

  create(title: string): Task {
    return this.createBatch([title])[0];
  }

  createBatch(titles: string[]): Task[] {
    // JSON preserves all accepted JavaScript strings, including escaped UTF-16 code units.
    const placeholders = titles.map(() => "(?)").join(", ");
    const rows = this.database.prepare(
      `INSERT INTO tasks (title_json) VALUES ${placeholders} RETURNING id, title_json`,
    ).all(...titles.map((title) => JSON.stringify(title)));
    return (rows as unknown as TaskRow[]).map(toTask).sort((a, b) => a.id - b.id);
  }
}
