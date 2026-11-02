// A minimal D1 stand-in over node:sqlite, so the domain core can be exercised
// end-to-end against the REAL migrations rather than mocks. Only the surface
// the core uses is implemented: prepare/bind/first/all/run and batch.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const norm = (args) => args.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
const plain = (r) => (r ? { ...r } : r);

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.db, this.sql, norm(a)); }
  async first() { return plain(this.db.prepare(this.sql).get(...this.args)) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map(plain), meta: {} }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; }
  exec() {
    const st = this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql)) return { results: st.all(...this.args).map(plain), meta: {} };
    const r = st.run(...this.args);
    return { results: [], meta: { changes: Number(r.changes) } };
  }
}

export function makeD1() {
  const raw = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort())
    raw.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  const db = {
    raw,
    prepare: (sql) => new Stmt(raw, sql),
    async batch(stmts) {
      raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.exec());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    /** Test helper: run a migration file again (e.g. a data migration after seeding). */
    rerun(file) { raw.exec(readFileSync(join(MIGRATIONS, file), "utf8")); },
  };
  return db;
}
