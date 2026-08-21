import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { Job, JobQueue, NewJob } from "./types.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    repo         TEXT NOT NULL,
    sha          TEXT NOT NULL,
    ref          TEXT NOT NULL,
    trigger      TEXT NOT NULL,
    status       TEXT NOT NULL,
    tag          TEXT,
    error        TEXT,
    created_at   TEXT NOT NULL,
    started_at   TEXT,
    finished_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
`;

export function createQueue(dbPath: string, now: () => Date = () => new Date()): JobQueue {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  // Jobs que ficaram "running" numa queda do processo não travam a fila para sempre.
  db.run(
    "UPDATE jobs SET status = 'failed', error = 'processo reiniciou durante o build' WHERE status = 'running'",
  );

  const insert = db.prepare(
    `INSERT INTO jobs (id, repo, sha, ref, trigger, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
  );
  const byId = db.query<Job, [string]>("SELECT * FROM jobs WHERE id = ?");

  return {
    enqueue(job: NewJob): Job {
      const id = randomUUID();
      insert.run(id, job.repo, job.sha, job.ref, job.trigger, now().toISOString());
      const created = byId.get(id);
      if (!created) throw new Error("falha ao gravar job");
      return created;
    },

    claimNext(): Job | null {
      // Transação: dois workers nunca pegam o mesmo job.
      const claim = db.transaction((): Job | null => {
        const next = db
          .query<Job, []>(
            "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1",
          )
          .get();
        if (!next) return null;
        db.run("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", [
          now().toISOString(),
          next.id,
        ]);
        return byId.get(next.id) ?? null;
      });
      return claim();
    },

    finish(id, status, patch): void {
      db.run("UPDATE jobs SET status = ?, tag = ?, error = ?, finished_at = ? WHERE id = ?", [
        status,
        patch.tag ?? null,
        patch.error ?? null,
        now().toISOString(),
        id,
      ]);
    },

    get(id) {
      return byId.get(id) ?? null;
    },

    list(limit) {
      return db
        .query<Job, [number]>("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
        .all(limit);
    },

    findPending(repo, sha) {
      return (
        db
          .query<Job, [string, string]>(
            "SELECT * FROM jobs WHERE repo = ? AND sha = ? AND status IN ('queued','running') LIMIT 1",
          )
          .get(repo, sha) ?? null
      );
    },

    close() {
      db.close();
    },
  };
}
