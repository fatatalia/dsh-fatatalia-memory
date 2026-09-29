# dsh-fatatalia-memory — 本地记忆库插件

用 **SQLite + FTS5 trigram** 保存 dsh 的**全部原始对话**，并提供零 LLM 成本的检索工具。
2026-09-29 起取代原 Hindsight（外部记忆）服务 —— 后者依赖 Postgres + HTTP 服务，
而实测表明「找回过去说过的话」这个真实需求，本地 SQLite 就够，且更快、无外部依赖、零 token。

随 dsh web 启停。

## 为什么不需要向量检索

原 Hindsight 走的是「embedding + 语义检索」。但实际使用中，**要找回的几乎都是原话**——
「我当时怎么说的」「那个决定是哪天定的」。这类查询用 **FTS5 全文索引**命中率足够，
而且：

- **零 LLM 成本**：不调 embedding，不调 rerank
- **毫秒级**：中文 trigram 检索最慢实测 44ms
- **可解释**：命中就是命中了，没有相似度阈值这种玄学

**语义检索不是目标。** 真需要「意思相近但用词不同」的检索时，agent 自己多换几个关键词更划算。

## 数据

**`~/.dsh/fatatalia-memory.db`**（可用插件 `Config` 覆盖）

| 表 | 内容 |
|---|---|
| `sessions` | 会话元数据（workspace / source / title / 起始时间 / `last_seq` 游标） |
| `messages` | 全部原始消息（`session_id` + `seq` + `role` + `content` + `timestamp` + `turn` + `step`） |
| `messages_fts` | FTS5（`unicode61`，英文/分词友好） |
| `messages_fts_trigram` | FTS5（`trigram`，**中文检索主力**） |
| `knowledge_pages` + `knowledge_fts` | 从 Hindsight 一次性导入的 17 个知识页 |

两个 FTS 表由**触发器自动同步**，无需手动维护。

## 工具（6 个，全部零 LLM 成本）

| 工具 | 签名 | 作用 |
|---|---|---|
| `memory_search` | `(query, limit=10, session_id?, role?)` | FTS5 检索历史对话，返回 `id` / `seq` / `time` / `role` / `session_id` / `snippet` |
| `memory_read` | `(id?, session_id?, around_seq?, limit=20)` | 读某条消息的**上下文**（同一会话，以它为中心前后各半） |
| `memory_recent` | `(limit=20, session_id?)` | 最近的对话记录（无检索词） |
| `knowledge_list` | `(query?)` | 列出知识页 |
| `knowledge_read` | `(id)` | 读取知识页全文（按 id 或标题） |
| `memory_stats` | `()` | 记忆库统计（消息数 / 会话数 / 知识页数 / 时间跨度） |

典型用法：`memory_search` 只给 400 字片段，看到命中后用 `memory_read(id=…)` 补上下文。
检索结果里的 `id` 就是为此准备的。

## ⚠️ 踩过的坑（改代码前必读）

### 1. FTS5 trigram 要求查询串 ≥3 个字符

`tokenize='trigram'` 把文本切成 **3 字符滑窗**，所以**不足 3 个字符的查询必然 0 命中**。
中文两字词（`教训`、`决定`、`记住`）全部落在这一档。

**因此 `search()` 必须分流**：`charLen(q) >= 3` 走 FTS5，否则回退 `LIKE '%q%'`。
`charLen` 用码点数而非 `String.length`（避免代理对把 emoji 算成 2 个字符）。

> 这个陷阱曾导致一次误判：「过滤把 `教训`/`决定` 的数据删没了」——
> 实际是 `MATCH` 返回 0，`LIKE` 查出来 50 / 123 / 18 条，内容完好。

### 2. FTS5 查询串里的 `-` 是语法字符

`MATCH 'system-reminder'` 会报 `no such column: reminder`。
`toFtsPhrase()` 负责把用户输入包成安全的短语查询。

### 3. `log.warn` 不会进 `/var/log/dsh-web.log`

dsh 的日志级别配置里只有 `info` 会落盘。**所有插件诊断必须用 `log.info`**，
否则出问题时日志里查不到任何线索。

### 4. `node:sqlite` 必须动态 import

Node 24 内置 `node:sqlite`，但**静态 `import` 会在模块加载期抛错**（旧版本 Node 没有它）。
本插件用 `await import("node:sqlite")` 惰性加载。

### 5. `turn/end` 截断必须推进游标到最后一条**已入库**的消息

早期版本在候选数超限时 `slice(0, N)` 截断，却把 `lastSeq` 推进到了**候选集末尾**，
导致被截掉的 1779 条**永久丢失**。

**正确做法**：截断时 `lastSeq` 只推进到「已入库的最后一条的 seq」，剩下的下一轮继续，最终收敛到全量。

### 6. 消息形状不对称（取错层级 = 静默丢数据）

session.log 里不同来源的消息，内容位置不同：

- `user/message` → `data.content`（**第 1 层**）
- `assistant/message` / `tool/result` / `system/message` / `developer/message` → `data.message.content`（**第 2 层**）

而且 `assistant/message.content` 是**混合数组**（`reasoning` / `tool-call` / `text` / `tool-result`），
**只有 `type === "text"` 才是真正的输出**，其余不该入库。

## 注入噪音过滤

dsh 每轮都会往会话里注入大量非对话内容，若原样入库会严重污染检索质量。
`lib/extract.mjs` 的 `isInjectedNoise()` 检查 `content` 前 80 字符，命中以下前缀即丢弃：

| 前缀 | 实测占比 |
|---|---|
| `Time sampled while preparing turn` | 349 条 / 3923 |
| `<system-reminder>` | 81 |
| `This is an automatically generated checkpoint` | 64 |
| `Current runtime context.` | 35 |
| `<hindsight_knowledge` | 30 |
| `Background subagent ` | 2 |

**合计过滤掉 14.3%**。效果：`user` 角色从 824 条降到 264 条 —— 剩下的全是真实发言。

**刻意不过滤**（携带真实证据，是对话的一部分）：
`<path>…</path>`、`External web content follows`、`The tool call was interrupted`。

## 目录

```
dsh-fatatalia-memory/
├── index.js              # host 插件：事件订阅 + 6 个工具 + 落库
├── lib/
│   ├── db.mjs            # SQLite 层：schema / FTS 迁移 / search / readAround / 知识页
│   └── extract.mjs       # 事件 → 消息的提取与噪音过滤
├── cordis.patch.yml
└── package.json
```

## 开发要点

- 新插件项目必须建依赖软链（`node_modules/@deepseek-ai` → dsh 全局依赖树），否则 import 报 `ERR_MODULE_NOT_FOUND`
- **`inject` 必须声明用到的每个服务**，漏了 `ctx.tools.register()` 会抛错
- **`ctx.on("session/event", (session, event) => …)`** —— 注意 `session` 是**第 1 个参数**
- 只关心 `turn/end`；`assistant/chunk` 是每 token 一条，必须立即短路
- 改代码后重启 web 生效（HMR 已禁用）：`launchctl kickstart -k system/com.dsh.web`
