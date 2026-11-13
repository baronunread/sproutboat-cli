// The queries. Every statement is prepared once with `?` placeholders and the values are bound, never concatenated.
import type { ListQuery, TaskPatch } from "./validate.ts";

export interface Task {
  id: number;
  title: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TaskRow {
  id: number;
  title: string;
  done: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS = "id, title, done, created_at, updated_at";

const toTask = (row: TaskRow): Task => ({
  id: row.id,
  title: row.title,
  done: row.done === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export async function createTask(db: Env["DB"], title: string): Promise<Task> {
  const row = await db
    .prepare(`INSERT INTO tasks (title) VALUES (?) RETURNING ${COLUMNS}`)
    .bind(title)
    .first<TaskRow>();
  if (!row) throw new Error("insert returned no row");
  return toTask(row);
}

export async function getTask(db: Env["DB"], id: number): Promise<Task | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).bind(id).first<TaskRow>();
  return row ? toTask(row) : null;
}

/** One page, oldest first. `next` is the id to pass as `after` for the following page, or null at the end. */
export async function listTasks(db: Env["DB"], query: ListQuery): Promise<{ tasks: Task[]; next: number | null }> {
  const filter = query.done === undefined ? "" : " AND done = ?";
  const values =
    query.done === undefined ? [query.after, query.limit + 1] : [query.after, Number(query.done), query.limit + 1];
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM tasks WHERE id > ?${filter} ORDER BY id LIMIT ?`)
    .bind(...values)
    .all<TaskRow>();
  // One more row than asked for says whether there is another page without a second COUNT query.
  const page = results.slice(0, query.limit).map(toTask);
  return { tasks: page, next: results.length > query.limit ? page[page.length - 1].id : null };
}

export async function updateTask(db: Env["DB"], id: number, patch: TaskPatch): Promise<Task | null> {
  const row = await db
    .prepare(
      `UPDATE tasks SET title = COALESCE(?, title), done = COALESCE(?, done),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING ${COLUMNS}`,
    )
    .bind(patch.title ?? null, patch.done === undefined ? null : Number(patch.done), id)
    .first<TaskRow>();
  return row ? toTask(row) : null;
}

export async function deleteTask(db: Env["DB"], id: number): Promise<boolean> {
  const { meta } = await db.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
  return meta.changes > 0;
}
