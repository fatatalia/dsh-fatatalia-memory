/**
 * dsh-fatatalia-memory · lib/db.mjs
 *
 * SQLite 存储层。用 **node:sqlite 内置模块**（Node 24 自带，SQLite 3.53.3），
 * 零外部依赖 —— 这是选它的核心理由：不必给 dsh 主实例塞 native 依赖。
 *
 * ── 检索分流（本文件最关键的一段逻辑）────────────────────────────────
 *
 * FTS5 `trigram` tokenizer 把文本切成 3 字符滑窗。**查询串不足 3 个字符时必然 0 命中**，
 * 与语料是否含该词无关。2026-09-29 实测（对 17 个知识页）：
 *
 *     「三」    (1 字) → 0      「SQL」  (3) → 6
 *     「三层」  (2 字) → 0      「iMe」  (3) → 14
 *     「三层记」(3 字) → 7  ← 门槛
 *
 * ⇒ 因此：**查询 ≥3 个字符走 FTS5 MATCH，<3 个字符回退 LIKE**。
 *   长度按 **Unicode 码点**数（`[...q].length`），中文一字算一个 —— `q.length`
 *   对代理对（emoji）会算 2，用码点更准。
 *
 * 这条规则不是我们自己想出来的，是 Hermes Agent 的 CJK 启发式：
 * 「≥3 个 CJK 字符 → trigram；1–2 个 → 回退 LIKE」。
 */
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** 把 `~/x` 展开成绝对路径。 */
export function expandPath(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export const DEFAULT_DB_PATH = join(homedir(), ".dsh", "fatatalia-memory.db");

/** 按 Unicode 码点数长度（CJK/emoji 友好）。 */
export function charLen(s) {
  return [...String(s ?? "")].length;
}

/** 把用户输入转成安全的 FTS5 短语查询（整串当一个 phrase）。 */
function toFtsPhrase(q) {
  return `"${String(q).replace(/"/g, '""')}"`;
}

export class MemoryDB {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.path = expandPath(dbPath);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this._init();
  }

  _init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        workspace     TEXT,
        source        TEXT,
        title         TEXT,
        started_at    REAL NOT NULL,
        ended_at      REAL,
        message_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq        INTEGER,
        role       TEXT NOT NULL,
        content    TEXT,
        timestamp  REAL NOT NULL,
        turn       INTEGER,
        step       INTEGER,
        event_type TEXT,
        tool_call_id TEXT,
        is_error   INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
      -- 注意：seq 相关索引不能放在这里。老库的 messages 表建表时还没有 seq 列，
      -- 索引会先于 _migrate() 的 ALTER 执行并报 no such column: seq。
      -- 它们在 _migrate() 补列成功之后才创建。

      -- 注意：两张 FTS 表必须同为 external-content。曾经把 messages_fts_trigram 建成
      -- inline（无 content=），结果删除触发器对 inline 表发 'delete' 命令必然报
      -- SQL logic error，连 DELETE FROM messages 都做不了（2026-09-29 实测）。
      -- 已验证 trigram 与 content=/content_rowid= 完全兼容（含 rebuild 与三种触发器）。
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, content='messages', content_rowid='id'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram USING fts5(
        content, content='messages', content_rowid='id', tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        INSERT INTO messages_fts_trigram(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content) VALUES('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        INSERT INTO messages_fts_trigram(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TABLE IF NOT EXISTS knowledge_pages (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        tags        TEXT,
        folder      TEXT,
        content     TEXT,
        source      TEXT,
        page_ts     TEXT,
        updated_at  REAL NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        name, description, content, tokenize='trigram'
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        session_id  TEXT PRIMARY KEY,
        last_seq    INTEGER NOT NULL DEFAULT -1,
        last_sync   REAL
      );

      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    this._migrate();
    this._stmts = {};
  }

  /**
   * 补列迁移。
   *
   * `CREATE TABLE IF NOT EXISTS` **不会**修改已存在的表 —— 探针阶段建的 messages 表
   * 只有 (id, session_id, role, content, timestamp)，缺 seq/turn/step/… 六列。
   * 直接跑预编译语句会炸 `no such column: seq`（2026-09-29 实测踩到）。
   * 因此这里显式检查并 ALTER 补列，老库无需重建、知识页数据不丢。
   */
  _migrate() {
    const have = new Set(this.db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name));
    const want = {
      seq: "INTEGER",
      turn: "INTEGER",
      step: "INTEGER",
      event_type: "TEXT",
      tool_call_id: "TEXT",
      is_error: "INTEGER DEFAULT 0",
    };
    const added = [];
    for (const [col, type] of Object.entries(want)) {
      if (!have.has(col)) {
        this.db.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
        added.push(col);
      }
    }
    // 无条件建（IF NOT EXISTS 幂等）—— 不能只在 added.length 时建：
    // 全新的库建表时就带 seq，added 为空，但索引仍然需要存在。
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(session_id, seq)`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_uniq ON messages(session_id, seq, role)`);

    this._migrateFts();
    return added;
  }

  /**
   * FTS 表模式迁移：把 inline 的 messages_fts_trigram 改造成 external-content。
   *
   * 探针阶段把它建成了 `fts5(content, tokenize='trigram')`（inline）。inline 表上
   * 发 `VALUES('delete', …)` 命令会报 `SQL logic error`，导致删除触发器把
   * `DELETE FROM messages` 一起拖死（2026-09-29 实测）。external-content 模式才支持
   * 该命令。`CREATE VIRTUAL TABLE IF NOT EXISTS` 不会改已存在的表，所以这里显式重建。
   */
  _migrateFts() {
    const row = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts_trigram'`
    ).get();
    if (!row?.sql || /content\s*=/.test(row.sql)) return false;   // 已是 external-content

    this.db.exec(`
      DROP TRIGGER IF EXISTS messages_fts_ai;
      DROP TRIGGER IF EXISTS messages_fts_ad;
      DROP TRIGGER IF EXISTS messages_fts_au;
      DROP TABLE IF EXISTS messages_fts_trigram;
      CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(
        content, content='messages', content_rowid='id', tokenize='trigram'
      );
      INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES('rebuild');
    `);
    this._createFtsTriggers();
    return true;
  }

  /** 建 FTS 同步触发器（重建表后需重跑）。 */
  _createFtsTriggers() {
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        INSERT INTO messages_fts_trigram(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content) VALUES('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        INSERT INTO messages_fts_trigram(rowid, content) VALUES (new.id, new.content);
      END;
    `);
  }

  /** 预编译语句缓存。 */
  _s(key, sql) {
    if (!this._stmts[key]) this._stmts[key] = this.db.prepare(sql);
    return this._stmts[key];
  }

  // ── 会话 ─────────────────────────────────────────────────────────────
  upsertSession({ id, workspace, source, title, startedAt }) {
    if (!id) return;
    this._s("upsertSession", `
      INSERT INTO sessions(id, workspace, source, title, started_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace = COALESCE(excluded.workspace, sessions.workspace),
        source    = COALESCE(excluded.source, sessions.source),
        title     = COALESCE(excluded.title, sessions.title)
    `).run(id, workspace ?? null, source ?? null, title ?? null, startedAt ?? Date.now() / 1000);
  }

  bumpSession(id, count = 0) {
    if (!id) return;
    this._s("bumpSession", `UPDATE sessions SET message_count = message_count + ? WHERE id = ?`).run(count, id);
  }

  setSessionTitle(id, title) {
    if (!id || !title) return;
    this._s("setTitle", `UPDATE sessions SET title = ? WHERE id = ?`).run(title, id);
    this._s("setTitleIns", `INSERT OR IGNORE INTO sessions(id, title, started_at) VALUES(?, ?, ?)`).run(id, title, Date.now() / 1000);
  }

  // ── 消息写入 ─────────────────────────────────────────────────────────
  /** 批量插入消息，返回实际新增条数（靠 UNIQUE(session_id,seq,role) 去重）。 */
  insertMessages(sessionId, msgs) {
    if (!sessionId || !Array.isArray(msgs) || !msgs.length) return 0;
    const st = this._s("insMsg", `
      INSERT OR IGNORE INTO messages
        (session_id, seq, role, content, timestamp, turn, step, event_type, tool_call_id, is_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const m of msgs) {
        const r = st.run(
          sessionId,
          m.seq ?? null,
          m.role ?? "unknown",
          m.content ?? "",
          m.timestamp ?? Date.now(),
          m.turn ?? null,
          m.step ?? null,
          m.eventType ?? null,
          m.toolCallId ?? null,
          m.isError ? 1 : 0,
        );
        if (r.changes) n += r.changes;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw e;
    }
    if (n) this.bumpSession(sessionId, n);
    return n;
  }

  /** 读某会话已同步到的最大 seq。 */
  getLastSeq(sessionId) {
    const r = this._s("getLastSeq", `SELECT last_seq FROM sync_state WHERE session_id = ?`).get(sessionId);
    return r?.last_seq ?? -1;
  }

  setLastSeq(sessionId, seq) {
    this._s("setLastSeq", `
      INSERT INTO sync_state(session_id, last_seq, last_sync) VALUES(?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET last_seq = excluded.last_seq, last_sync = excluded.last_sync
    `).run(sessionId, seq ?? -1, Date.now());
  }

  // ── ★ 检索分流 ───────────────────────────────────────────────────────
  /**
   * 检索历史对话。
   * @param {string} query
   * @param {{limit?:number, sessionId?:string, roles?:string[], since?:number}} opts
   */
  search(query, opts = {}) {
    const q = String(query ?? "").trim();
    if (!q) return [];
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
    const clauses = [];
    const params = [];

    if (opts.sessionId) { clauses.push("m.session_id = ?"); params.push(opts.sessionId); }
    if (opts.since) { clauses.push("m.timestamp >= ?"); params.push(opts.since); }
    if (Array.isArray(opts.roles) && opts.roles.length) {
      clauses.push(`m.role IN (${opts.roles.map(() => "?").join(",")})`);
      params.push(...opts.roles);
    }
    const filter = clauses.length ? " AND " + clauses.join(" AND ") : "";

    // ≥3 码点走 FTS5 trigram
    if (charLen(q) >= 3) {
      try {
        const rows = this._s("searchFts" + filter, `
          SELECT m.id, m.session_id, m.seq, m.role, m.content, m.timestamp, m.turn, m.step,
                 snippet(messages_fts_trigram, 0, '«', '»', '…', 24) AS snip,
                 bm25(messages_fts_trigram) AS score
          FROM messages_fts_trigram f
          JOIN messages m ON m.id = f.rowid
          WHERE messages_fts_trigram MATCH ?${filter}
          ORDER BY score LIMIT ?
        `).all(toFtsPhrase(q), ...params, limit);
        if (rows.length) return rows.map((r) => ({ ...r, via: "fts" }));
      } catch { /* 语法错误等 → 落 LIKE */ }
    }

    // <3 码点，或 FTS 无果 → LIKE 回退
    // ⚠️ 缓存 key 必须带 filter：SQL 的占位符个数随 filter 变化，
    //    若共用同一个 key，第二次会拿旧语句配新参数 → column index out of range。
    const rows = this._s("searchLike" + filter, `
      SELECT m.id, m.session_id, m.seq, m.role, m.content, m.timestamp, m.turn, m.step,
             substr(m.content, 1, 240) AS snip, 0 AS score
      FROM messages m
      WHERE m.content LIKE ?${filter}
      ORDER BY m.timestamp DESC LIMIT ?
    `).all(`%${q}%`, ...params, limit);
    return rows.map((r) => ({ ...r, via: "like" }));
  }

  /** 最近 N 条消息（无查询词，按时间倒序）。 */
  recent(limit = 20, sessionId = null) {
    const l = Math.min(Math.max(limit, 1), 200);
    if (sessionId) {
      return this._s("recentOne", `
        SELECT id, session_id, seq, role, content, timestamp, turn, step
        FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?
      `).all(sessionId, l);
    }
    return this._s("recentAll", `
      SELECT id, session_id, seq, role, content, timestamp, turn, step
      FROM messages ORDER BY timestamp DESC LIMIT ?
    `).all(l);
  }

  // ── 上下文读取（memory_read 用）─────────────────────────────────────
  /** 按消息 id 取单条（用于拿到它的 session_id / seq 当锚点）。 */
  getMessage(id) {
    const n = Number(id);
    if (!Number.isFinite(n)) return null;
    return this._s("getMessage", `
      SELECT id, session_id, seq, role, content, timestamp, turn, step
      FROM messages WHERE id = ?
    `).get(n) ?? null;
  }

  /**
   * 以某条消息为中心读上下文（同一会话，前后各半）。
   *
   * 为什么需要它：`memory_search` 只返回 400 字片段，看不到「这句话的前因后果」。
   * 本方法补上上下文窗口。
   *
   * @param sessionId 会话 id
   * @param centerSeq 中心 seq；非有限数时退化为「该会话最近 limit 条」
   * @param limit     总条数（含中心点），1-200
   */
  readAround(sessionId, centerSeq, limit = 20) {
    const sid = String(sessionId ?? "");
    if (!sid) return [];
    const l = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const center = Number(centerSeq);
    const COLS = "id, session_id, seq, role, content, timestamp, turn, step";

    // 无中心点 → 该会话最近 l 条（正序返回，方便阅读）
    if (!Number.isFinite(center)) {
      return this._s("readAroundTail", `
        SELECT ${COLS} FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?
      `).all(sid, l).reverse();
    }

    const half = Math.floor(l / 2);
    const before = this._s("readAroundBefore", `
      SELECT ${COLS} FROM messages WHERE session_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?
    `).all(sid, center, l - half);
    const after = this._s("readAroundAfter", `
      SELECT ${COLS} FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?
    `).all(sid, center, half);
    return [...before.reverse(), ...after];
  }

  // ── 知识页 ───────────────────────────────────────────────────────────
  /** 检索知识页（同样分流）。 */
  searchKnowledge(query, limit = 5) {
    const q = String(query ?? "").trim();
    if (!q) return [];
    const l = Math.min(Math.max(limit, 1), 50);
    if (charLen(q) >= 3) {
      try {
        const rows = this._s("kFts", `
          SELECT p.id, p.name, p.folder, snippet(knowledge_fts, 2, '«', '»', '…', 20) AS snip,
                 bm25(knowledge_fts) AS score
          FROM knowledge_fts f JOIN knowledge_pages p ON p.rowid = f.rowid
          WHERE knowledge_fts MATCH ? ORDER BY score LIMIT ?
        `).all(toFtsPhrase(q), l);
        if (rows.length) return rows.map((r) => ({ ...r, via: "fts" }));
      } catch {}
    }
    return this._s("kLike", `
      SELECT id, name, folder, substr(content, 1, 240) AS snip, 0 AS score
      FROM knowledge_pages WHERE name LIKE ? OR content LIKE ? LIMIT ?
    `).all(`%${q}%`, `%${q}%`, l).map((r) => ({ ...r, via: "like" }));
  }

  listKnowledge() {
    return this._s("kList", `SELECT id, name, folder, updated_at FROM knowledge_pages ORDER BY name`).all();
  }

  readKnowledge(id) {
    return this._s("kRead", `SELECT * FROM knowledge_pages WHERE id = ? OR name = ? LIMIT 1`).get(id, id) ?? null;
  }

  // ── 统计 ─────────────────────────────────────────────────────────────
  stats() {
    const g = (sql) => this.db.prepare(sql).get();
    return {
      dbPath: this.path,
      sessions: g(`SELECT COUNT(*) AS n FROM sessions`).n,
      messages: g(`SELECT COUNT(*) AS n FROM messages`).n,
      byRole: this.db.prepare(`SELECT role, COUNT(*) AS n FROM messages GROUP BY role ORDER BY n DESC`).all(),
      knowledge: g(`SELECT COUNT(*) AS n FROM knowledge_pages`).n,
      oldest: g(`SELECT MIN(timestamp) AS t FROM messages`).t,
      newest: g(`SELECT MAX(timestamp) AS t FROM messages`).t,
    };
  }

  close() {
    try { this.db.close(); } catch {}
  }
}
