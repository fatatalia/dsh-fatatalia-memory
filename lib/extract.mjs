/**
 * dsh-fatatalia-memory · lib/extract.mjs
 *
 * 从 `session.log` 提取消息。log 是「全量事件流」，事件类型经 2026-09-29 实测确认
 * （样本 10067 条，会话 gateway-mufaeycc6d7mbr-gw）：
 *
 *   step/start 1543 · assistant/message 1543 · step/end 1543
 *   tool/result 1527 · tool/call 1479 · user/message 763
 *   agent/inbox/spliced 499 · turn/start|end 243 · session/title 242
 *   compaction/summary 59 · system/message 3 · developer/message 3
 *
 * ⚠️ 三种消息事件的**结构不统一**，这是本文件存在的理由：
 *
 *   user/message      → content 在 `data.content`（第一层），**没有 turn/step**
 *   assistant/message → content 在 `data.message.content`（第二层），有 turn/step
 *   tool/result       → content 在 `data.message.content`（第二层），有 turn/step
 *   system/message    → content 在 `data.message.content`
 *   developer/message → content 在 `data.message.content`
 *
 * ⚠️ `assistant/message.content` 混装 `reasoning` / `tool-call` / `text` / `tool-result`
 *    多种 type —— **只有 `type === "text"` 是模型的实际输出**，其余是过程。
 *    默认只取 text（reasoning 体积大且属过程性内容）；需要时用 includeReasoning 打开。
 *
 * ⚠️ `agent.frozenMessages` 在 turn/end 时是 `object{0}` **空对象** —— 不是消息数组，
 *    不要走那条路（2026-09-29 实测否证）。
 */

/**
 * 注入类噪音前缀 —— 这些**不是对话内容**，而是 harness / 插件每轮塞进上下文的元信息。
 * 2026-09-29 实测统计（3923 条库内数据）：
 *
 *   "Time sampled while preparing turn …"                 349 条  harness 每步时间采样
 *   "This is an automatically generated checkpoint …"      64 条  压缩摘要（原文已在库，纯冗余）
 *   "<system-reminder>…"                                   81 条  AGENTS.md / skill 目录注入
 *   "Current runtime context. This snapshot …"             35 条  运行时快照
 *   "<hindsight_knowledge…>…"                              30 条  Hindsight banner（插件已卸，仅存于历史）
 *   "Background subagent …"                                 2 条  子代理通知
 *   ─────────────────────────────────────────────────────────────
 *   合计 559 / 3923 = 14.2%，扣掉后 824 条 user 里只剩约 265 条真人发言。
 *
 * 危害不只是占体积：这些文本**重复且含高频词**，会污染 FTS5 排序 ——
 * 实测拿「教训 / 决定 / 记住」检索，返回的头部全是 `<system-reminder>`。
 */
const INJECTED_NOISE_PREFIXES = [
  "Time sampled while preparing turn",
  "This is an automatically generated checkpoint",
  "<system-reminder>",
  "Current runtime context.",
  "<hindsight_knowledge",
  "Background subagent ",
];

/** 该条内容是否是注入类噪音（应丢弃，不入库）。 */
export function isInjectedNoise(content) {
  if (typeof content !== "string") return false;
  const head = content.slice(0, 80);
  return INJECTED_NOISE_PREFIXES.some((p) => head.startsWith(p) || head.includes(p));
}

/** 从 content 数组里取纯文本。 */
function joinText(content, { includeReasoning = false } = {}) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (includeReasoning && c.type === "reasoning" && typeof c.text === "string") parts.push(c.text);
  }
  return parts.join("\n");
}

/** 该事件是否是「可入库的消息」。 */
export function isMessageEvent(type) {
  return type === "user/message" || type === "assistant/message" || type === "tool/result"
      || type === "system/message" || type === "developer/message";
}

/**
 * 从一条 log 事件提取消息。非消息事件返回 null。
 * @returns {{seq, role, content, timestamp, turn, step, id, toolCallId, isError}|null}
 */
export function extractOne(ev, opts = {}) {
  if (!ev || typeof ev !== "object") return null;
  const type = ev.type;
  if (!isMessageEvent(type)) return null;
  const d = ev.data ?? {};

  let role, content, id, toolCallId, isError, turn, step;

  if (type === "user/message") {
    role = d.role || "user";
    content = joinText(d.content, opts);
    id = d.id;
    turn = typeof d.turn === "number" ? d.turn : null;   // 实测通常没有
    step = typeof d.step === "number" ? d.step : null;
  } else {
    const m = d.message ?? {};
    role = m.role || type.split("/")[0];
    content = joinText(m.content, opts);
    id = m.id;
    toolCallId = m.toolCallId;
    isError = m.isError;
    turn = typeof d.turn === "number" ? d.turn : null;
    step = typeof d.step === "number" ? d.step : null;
  }

  if (!content || !content.trim()) return null;
  // 注入类噪音不入库（详见文件上方 INJECTED_NOISE_PREFIXES）。
  if (!opts.keepInjected && isInjectedNoise(content)) return null;

  return {
    seq: ev.seq,
    role,
    content,
    timestamp: typeof ev.time === "number" ? ev.time : Date.now(),
    turn, step,
    id: id ?? null,
    toolCallId: toolCallId ?? null,
    isError: isError === true,
    eventType: type,
  };
}

/**
 * 从整条 log 提取消息（增量友好：`sinceSeq` 之后的事件）。
 * @param {Array} log session.log
 * @param {{sinceSeq?:number, includeReasoning?:boolean}} opts
 */
export function extractMessages(log, opts = {}) {
  const { sinceSeq = -1 } = opts;
  if (!Array.isArray(log)) return [];
  const out = [];
  for (const ev of log) {
    if (typeof ev?.seq === "number" && ev.seq <= sinceSeq) continue;
    const m = extractOne(ev, opts);
    if (m) out.push(m);
  }
  return out;
}

/** 统计 log 里的事件类型分布（诊断用）。 */
export function typeHistogram(log) {
  const h = {};
  if (!Array.isArray(log)) return h;
  for (const ev of log) {
    const t = ev?.type ?? "(no-type)";
    h[t] = (h[t] ?? 0) + 1;
  }
  return h;
}
