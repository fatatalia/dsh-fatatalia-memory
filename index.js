/**
 * dsh-fatatalia-memory — 自研记忆插件（SQLite FTS5）
 *
 * 用 SQLite FTS5 取代 Hindsight 在这一层的实际用途：零 LLM 成本的历史会话检索。
 * 与 Hindsight 的分工（本插件**不**做）：不做语义/向量检索、不做 reflect 式深度推理、
 * 不做知识页的自动生成与刷新。它只做一件 Hindsight 做得昂贵的事：
 * **把对话原样存下来，让你能按关键词毫秒级翻回去。**
 *
 * ── 已由实测钉死的事实（2026-09-29，会话 gateway-mufaeycc6d7mbr-gw）────────
 *
 * 1. 事件订阅：`ctx.on("session/event", (session, event) => …)`；
 *    `turn/end` 的载荷是 `{type, seq, time, data:{turn, reason}}` —— **event 不含正文**。
 * 2. 正文在 **`session.log`**（`array[N]`，实测 10067 条），是一条全量事件流。
 *    消息事件类型：`user/message` / `assistant/message` / `tool/result`
 *    / `system/message` / `developer/message`（结构不统一，见 lib/extract.mjs）。
 * 3. `agent.frozenMessages` 在 turn/end 时是 **`object{0}` 空对象** —— 不是消息数组。
 * 4. **`sessionPersistence` 必须写进 `inject`**，否则 `ctx.get()` 静默返回 undefined。
 * 5. **`sessionPersistence.load()` 不存在**（54 个真实方法里没有它）。
 * 6. FTS5 `trigram` **查询 <3 个字符必然 0 命中** —— 故检索必须 FTS/LIKE 分流。
 *
 * ── 本插件的定位（一句话）────────────────────────────────────────────
 * 它是一台**录像机**，不是**大脑**：忠实、便宜、随时可查。
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { MemoryDB, DEFAULT_DB_PATH, charLen } from "./lib/db.mjs";
import { extractMessages } from "./lib/extract.mjs";

export const name = "dsh-fatatalia-memory";

/**
 * agents：拿 agent 对象（诊断用）。
 * sessions：session 事件由它发布。
 * sessionPersistence：**必须声明**，否则 ctx.get 拿不到（实测踩过）。
 * tools：**注册工具必须声明**。漏了它，`ctx.tools.register()` 会抛错，apply() 从那一行
 *        起整体中断 —— 而排在其后的 `ctx.on("session/event")` 也就从未注册。症状很隐蔽：
 *        日志停在「库已就绪」，库永远是 0 条，看起来像事件没触发，其实是插件没装完。
 *        参考：dsh-dreaming / dsh-fatatalia-tools / dsh-synology-calendar 三个注册工具的
 *        插件，inject 里都有 "tools"。2026-09-29 实测踩到。
 */
export const inject = ["agents", "sessions", "sessionPersistence", "tools"];

export const Config = z.object({
  /** SQLite 库路径。 */
  dbPath: z.string().default(DEFAULT_DB_PATH),
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /** 是否把 assistant 的 reasoning 也入库（体积大，默认关）。 */
  storeReasoning: z.boolean().default(false),
  /** 单个 turn 最多入库多少条（防御性上限）。 */
  maxPerTurn: z.number().default(2000),
  /** 日志详细程度。 */
  verbose: z.boolean().default(true),
});

function makeLogger(ctx, verbose) {
  const ts = () => new Date().toISOString();
  const on = () => verbose !== false;
  return {
    info: (m) => { if (!on()) return; console.log(`[${ts()}] [mem] ${m}`); try { ctx.logger?.info?.(`[fatatalia-memory] ${m}`); } catch {} },
    warn: (m) => { if (!on()) return; console.warn(`[${ts()}] [mem:warn] ${m}`); try { ctx.logger?.warn?.(`[fatatalia-memory] ${m}`); } catch {} },
    error: (m) => { console.error(`[${ts()}] [mem:err] ${m}`); try { ctx.logger?.error?.(`[fatatalia-memory] ${m}`); } catch {} },
  };
}

/** 时间戳（ms）→ 本地可读。 */
function fmtTime(ts) {
  if (!ts) return "?";
  const ms = ts < 1e12 ? ts * 1000 : ts;   // 容忍秒/毫秒两种单位
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 截断长文本（展示用）。 */
function clip(s, n = 300) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export function apply(ctx, config = {}) {
  const cfg = { dbPath: DEFAULT_DB_PATH, enabled: true, storeReasoning: false, maxPerTurn: 2000, verbose: true, ...config };
  const log = makeLogger(ctx, cfg.verbose);
  const agents = ctx.agents;

  if (!cfg.enabled) { log.info("插件已禁用（enabled=false），不加载"); return; }

  const db = new MemoryDB(cfg.dbPath);
  const s0 = db.stats();
  log.info(`库已就绪：${db.path}`);
  log.info(`  会话 ${s0.sessions} · 消息 ${s0.messages} · 知识页 ${s0.knowledge}`);

  // ── 核心：turn/end 时把本轮新消息落库 ────────────────────────────────
  let turnsSeen = 0;
  let totalInserted = 0;
  ctx.on("session/event", (session, event) => {
    // 只关心 turn 边界。其余事件（含每 token 一条的 assistant/chunk）立即短路，不进日志。
    if (event?.type !== "turn/end") return;

    const sid = session?.id;
    const slog = Array.isArray(session?.log) ? session.log : null;
    if (!sid) { log.error("turn/end：无 session.id，跳过"); return; }
    if (!slog) { log.error("turn/end：session.log 不是数组，跳过"); return; }

    turnsSeen++;

    try {
      // 会话元信息
      const h = session?.header ?? {};
      db.upsertSession({
        id: sid,
        workspace: h.cwd ?? null,
        source: h.agentPreset ?? null,
        startedAt: typeof h.createdAt === "number" ? h.createdAt / 1000 : null,
      });

      // 增量提取：只处理 seq > lastSeq 的事件
      const last = db.getLastSeq(sid);
      let msgs = extractMessages(slog, { sinceSeq: last, includeReasoning: cfg.storeReasoning });

      // 上限只用来限制单轮事务规模，**绝不能造成永久丢失**。
      // 两条纪律（2026-09-29 双双踩过）：
      //   1. 必须从头截 slice(0, N)，不能 slice(-N)。取尾部会让 lastSeq 照样停在末尾，
      //      前面的历史永远补不回来 —— 加了下游修复也救不了，因为「剩下的」是 0 条。
      //   2. 截断后 lastSeq 只推进到「已入库的最后一条」，剩下的留给下一轮。
      let truncated = 0;
      if (msgs.length > cfg.maxPerTurn) {
        truncated = msgs.length - cfg.maxPerTurn;
        msgs = msgs.slice(0, cfg.maxPerTurn);
        // 必须是 info：log.warn 不进 /var/log/dsh-web.log，这条告警曾因此静默失联，
        // 掩盖了一次 1748 条消息的截断丢失（2026-09-29）。
        log.info(`本轮候选 ${msgs.length + truncated} 条超过上限 ${cfg.maxPerTurn}，本轮入库前 ${msgs.length} 条，剩余 ${truncated} 条下轮继续`);
      }

      const n = msgs.length ? db.insertMessages(sid, msgs) : 0;
      totalInserted += n;
      // 即使 0 条也记录：用来区分「log 里确实没有新消息」和「提取器漏了」。
      log.info(`turn/end：会话 ${sid} 候选 ${msgs.length} 条 / 入库 ${n} 条（lastSeq=${last}${truncated ? `，截断 ${truncated} 条待续` : ""}）`);

      // 推进 lastSeq。
      // 截断时只走到已入库的最后一条，否则被截掉的部分永远不会再被提取。
      let maxSeq = last;
      if (truncated > 0) {
        for (const m of msgs) if (typeof m?.seq === "number" && m.seq > maxSeq) maxSeq = m.seq;
      } else {
        for (const ev of slog) if (typeof ev?.seq === "number" && ev.seq > maxSeq) maxSeq = ev.seq;
      }
      if (maxSeq > last) db.setLastSeq(sid, maxSeq);

      // 顺手同步会话标题（session/title 事件，从尾部往前找）
      for (let i = slog.length - 1, seen = 0; i >= 0 && seen < 80; i--, seen++) {
        const ev = slog[i];
        if (ev?.type === "session/title" && ev.data?.title) { db.setSessionTitle(sid, String(ev.data.title)); break; }
      }
    } catch (e) {
      log.error(`turn/end 落库失败：${e instanceof Error ? e.message : e}`);
    }
  });

  // ── 工具 1：memory_search ────────────────────────────────────────────
  const searchTool = defineTool({
    name: "memory_search",
    description:
      "检索历史对话记录（本地 SQLite，零 LLM 成本，毫秒级）。用于找回过去说过的内容、决策、细节。" +
      "支持中文与英文：查询 ≥3 个字符走 FTS5 trigram 全文索引，不足 3 个字符自动回退子串匹配。",
    parameters: {
      query: { type: "string", description: "检索词（中文或英文均可）" },
      limit: { type: "number", description: "返回条数，默认 10，最大 50" },
      session_id: { type: "string", description: "限定某个会话 id（可选）" },
      role: { type: "string", description: "限定角色：user / assistant / tool（可选）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: { type: "number", required: true },
          via: { type: "string", required: true },
          results: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                id: { type: "number", required: true },
                seq: { type: "number", required: true },
                time: { type: "string", required: true },
                role: { type: "string", required: true },
                session_id: { type: "string", required: true },
                snippet: { type: "string", required: true },
              },
            },
          },
        },
      },
      render(_args, v) {
        if (!v?.results?.length) return [{ type: "text", text: "未找到匹配记录。" }];
        const lines = [
          `找到 ${v.count} 条（检索方式：${v.via}）：`,
          "",
          "（要看某条的上下文，用 memory_read(id=<id>)）",
          "",
        ];
        for (const r of v.results) lines.push(`#[${r.id}] [${r.time}] ${r.role} (${r.session_id})\n  ${r.snippet}`);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      const q = String(args?.query ?? "").trim();
      const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 50);
      const roles = args?.role ? [String(args.role)] : null;
      const rows = db.search(q, { limit, sessionId: args?.session_id ?? null, roles });
      return {
        count: rows.length,
        via: charLen(q) >= 3 ? "fts5-trigram" : "like",
        results: rows.map((r) => ({
          id: r.id,
          seq: r.seq,
          time: fmtTime(r.timestamp),
          role: r.role,
          session_id: r.session_id,
          snippet: clip(r.snip ?? r.content, 400),
        })),
      };
    },
  });

  // ── 工具 2：memory_read ──────────────────────────────────────────────
  // 2026-09-29 补：计划 §4.4 里列了本工具但当时没实现 —— `memory_search` 只返回
  // 400 字片段，看到命中却看不到「它的前因后果」，只能自己写 SQL 戳库。现补齐。
  const readTool = defineTool({
    name: "memory_read",
    description:
      "读某条消息的上下文（同一会话，以它为中心取前后各半）。配合 memory_search 使用：" +
      "search 只给 400 字片段，本工具补上前后文，看清一句话是在什么语境里说的。" +
      "只给 session_id（不给 id / around_seq）时，返回该会话最近的记录。",
    parameters: {
      id: { type: "number", description: "消息 id（memory_search 结果里的 id）—— 以它为锚点" },
      session_id: { type: "string", description: "会话 id（可选；给了 id 会自动推断）" },
      around_seq: { type: "number", description: "中心位置 seq（可选；与 id 二选一）" },
      limit: { type: "number", description: "返回条数，默认 20，最大 200" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          found: { type: "boolean", required: true },
          session_id: { type: "string", required: true },
          count: { type: "number", required: true },
          center_id: { type: "number", required: true },
          messages: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                id: { type: "number", required: true },
                seq: { type: "number", required: true },
                time: { type: "string", required: true },
                role: { type: "string", required: true },
                content: { type: "string", required: true },
              },
            },
          },
        },
      },
      render(_args, v) {
        if (!v?.found) return [{ type: "text", text: "未找到该会话或消息。" }];
        const head = v.center_id
          ? `会话 ${v.session_id} · 以 #${v.center_id} 为中心 · ${v.count} 条`
          : `会话 ${v.session_id} · 最近 ${v.count} 条`;
        const lines = [head, ""];
        for (const m of v.messages) {
          const mark = m.id === v.center_id ? " ←★" : "";
          lines.push(`#[${m.id}] seq=${m.seq} [${m.time}] ${m.role}${mark}`);
          lines.push(`  ${clip(m.content, 1200)}`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 200);
      let sessionId = args?.session_id ? String(args.session_id) : null;
      let centerSeq = Number.isFinite(Number(args?.around_seq)) ? Number(args.around_seq) : null;
      let centerId = 0;

      // 给了 id → 自己查出 session_id / seq / 时间，当锚点用
      if (Number.isFinite(Number(args?.id))) {
        const anchor = db.getMessage(Number(args.id));
        if (!anchor) {
          return { found: false, session_id: sessionId ?? "", count: 0, center_id: 0, messages: [] };
        }
        sessionId = anchor.session_id;
        centerSeq = anchor.seq;
        centerId = anchor.id;
      }
      if (!sessionId) {
        return { found: false, session_id: "", count: 0, center_id: 0, messages: [] };
      }

      const rows = db.readAround(sessionId, centerSeq, limit);
      return {
        found: rows.length > 0,
        session_id: sessionId,
        count: rows.length,
        center_id: centerId,
        messages: rows.map((r) => ({
          id: r.id,
          seq: r.seq,
          time: fmtTime(r.timestamp),
          role: r.role,
          content: r.content ?? "",
        })),
      };
    },
  });

  // ── 工具 3：memory_recent ────────────────────────────────────────────
  const recentTool = defineTool({
    name: "memory_recent",
    description: "查看最近的对话记录（按时间倒序，无检索词）。用于快速回顾刚刚说了什么。",
    parameters: {
      limit: { type: "number", description: "返回条数，默认 20，最大 100" },
      session_id: { type: "string", description: "限定某个会话 id（可选）" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          count: { type: "number", required: true },
          results: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                time: { type: "string", required: true },
                role: { type: "string", required: true },
                session_id: { type: "string", required: true },
                snippet: { type: "string", required: true },
              },
            },
          },
        },
      },
      render(_a, v) {
        if (!v?.results?.length) return [{ type: "text", text: "库中还没有消息。" }];
        return [{ type: "text", text: v.results.map((r) => `[${r.time}] ${r.role}: ${r.snippet}`).join("\n") }];
      },
    },
    async execute(args) {
      const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100);
      const rows = db.recent(limit, args?.session_id ?? null);
      return {
        count: rows.length,
        results: rows.map((r) => ({ time: fmtTime(r.timestamp), role: r.role, session_id: r.session_id, snippet: clip(r.content, 300) })),
      };
    },
  });

  // ── 工具 4：knowledge_list ───────────────────────────────────────────
  const kListTool = defineTool({
    name: "knowledge_list",
    description: "列出知识页（从 Hindsight 导出的倡议/架构页面，存本地 SQLite）。",
    parameters: {
      query: { type: "string", description: "可选的检索词，留空则列全部" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          count: { type: "number", required: true },
          pages: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                name: { type: "string", required: true },
                folder: { type: "string", required: true },
                snippet: { type: "string", required: true },
              },
            },
          },
        },
      },
      render(_a, v) {
        if (!v?.pages?.length) return [{ type: "text", text: "没有匹配的知识页。" }];
        // id 必须完整输出：knowledge_read 靠它取正文，截断或省略就等于没给。
        return [{ type: "text", text: `${v.count} 个知识页：\n` + v.pages.map((p) => `· ${p.name}\n    id: ${p.id}${p.snippet ? `\n    ${p.snippet}` : ""}`).join("\n") }];
      },
    },
    async execute(args) {
      const q = String(args?.query ?? "").trim();
      if (q) {
        const rows = db.searchKnowledge(q, 20);
        return { count: rows.length, pages: rows.map((r) => ({ id: r.id, name: r.name, folder: r.folder ?? "", snippet: clip(r.snip, 200) })) };
      }
      const rows = db.listKnowledge();
      return { count: rows.length, pages: rows.map((r) => ({ id: r.id, name: r.name, folder: r.folder ?? "", snippet: "" })) };
    },
  });

  // ── 工具 5：knowledge_read ───────────────────────────────────────────
  const kReadTool = defineTool({
    name: "knowledge_read",
    description: "读取一个知识页的完整正文（按 id 或标题）。",
    parameters: {
      id: { type: "string", description: "知识页 id（kp-…）或标题" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          found: { type: "boolean", required: true },
          name: { type: "string", required: true },
          content: { type: "string", required: true },
        },
      },
      render(_a, v) {
        if (!v?.found) return [{ type: "text", text: "未找到该知识页。" }];
        return [{ type: "text", text: `# ${v.name}\n\n${v.content}` }];
      },
    },
    async execute(args) {
      const row = db.readKnowledge(String(args?.id ?? ""));
      if (!row) return { found: false, name: "", content: "" };
      return { found: true, name: row.name, content: row.content ?? "" };
    },
  });

  // ── 工具 6：memory_stats ─────────────────────────────────────────────
  const statsTool = defineTool({
    name: "memory_stats",
    description: "查看本地记忆库的统计信息（消息数、会话数、知识页数、时间跨度）。",
    parameters: {},
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          db_path: { type: "string", required: true },
          sessions: { type: "number", required: true },
          messages: { type: "number", required: true },
          knowledge: { type: "number", required: true },
          oldest: { type: "string", required: true },
          newest: { type: "string", required: true },
          by_role: { type: "string", required: true },
        },
      },
      render(_a, v) {
        return [{ type: "text", text:
          `库: ${v.db_path}\n会话 ${v.sessions} · 消息 ${v.messages} · 知识页 ${v.knowledge}\n` +
          `时间跨度: ${v.oldest} → ${v.newest}\n角色分布: ${v.by_role}` }];
      },
    },
    async execute() {
      const st = db.stats();
      return {
        db_path: st.dbPath,
        sessions: st.sessions,
        messages: st.messages,
        knowledge: st.knowledge,
        oldest: fmtTime(st.oldest),
        newest: fmtTime(st.newest),
        by_role: st.byRole.map((r) => `${r.role}:${r.n}`).join(" "),
      };
    },
  });

  for (const t of [searchTool, readTool, recentTool, kListTool, kReadTool, statsTool]) ctx.tools.register(t);
  log.info(`已注册 6 个工具：memory_search / memory_read / memory_recent / knowledge_list / knowledge_read / memory_stats`);

  ctx.on("dispose", () => {
    log.info(`卸载（本次进程共处理 ${turnsSeen} 个 turn / 写入 ${totalInserted} 条消息）`);
    db.close();
  });
}
