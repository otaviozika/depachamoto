// Isolated test adapter only. The loader explicitly intercepts pg for server.js;
// neither production start nor application modules import this file.
import { EventEmitter } from "node:events";
import { PGlite } from "@electric-sql/pglite";

export class Pool extends EventEmitter {
  constructor() {
    super();
    this.db = new PGlite();
    this.tail = Promise.resolve();
    this.credentialCommitted = false;
    this.failSessionSaveOnce = process.env.ISOLATED_SESSION_SAVE_FAILURE === "true";
  }
  async lock() {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  }
  async execute(sql, args = []) {
    if (this.failSessionSaveOnce && this.credentialCommitted && /^INSERT INTO .*user_sessions/i.test(sql)) {
      this.failSessionSaveOnce = false;
      throw new Error("Synthetic test-only session store failure.");
    }
    let result;
    if (!args.length && sql.includes(";")) result = (await this.db.exec(sql)).at(-1);
    else result = await this.db.query(sql, args);
    if (sql.includes("session_version=session_version+1")) this.credentialUpdatePending = true;
    if (sql === "COMMIT" && this.credentialUpdatePending) { this.credentialCommitted = true; this.credentialUpdatePending = false; }
    if (sql === "ROLLBACK") this.credentialUpdatePending = false;
    return { ...result, rowCount: result.affectedRows || result.rows.length };
  }
  query(sql, args = [], callback) {
    if (typeof args === "function") { callback = args; args = []; }
    if (typeof sql === "object") { args = sql.values || []; sql = sql.text; }
    const promise = (async () => {
      const release = await this.lock();
      try { return await this.execute(sql, args); } finally { release(); }
    })();
    if (callback) { promise.then(result => callback(null, result), error => callback(error)); return; }
    return promise;
  }
  async connect() {
    const release = await this.lock();
    return { query: (sql, args = []) => this.execute(sql, args), release };
  }
  async end() { await this.db.close(); }
}
export default { Pool };
