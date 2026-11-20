# 记忆系统重构方案

> 状态：**P0 已完成（2026-11-20），P1–P5 待实施。**
> 原则：**记忆相关的处理全部聚合进一个插件**，不散落在 preset 条文、AGENTS.md、脚本里。
> 出了问题只翻这一个仓库。
>
> **本方案的核心决策（每条都有代价，都经过讨论推翻过若干次）：**
>
> | 决策 | 结论 | 代价 / 补偿 |
> |---|---|---|
> | 插件数量 | **合并 `dsh-dreaming` + `dsh-fatatalia-memory` 为一个包、一个 id** | 单一失败域；靠代码纪律缓解 |
> | 插件名 | **保留 `dsh-dreaming`** | 名字与职责不符；README 一句话说明。补偿：零迁移成本 |
> | `MEMORY.md` 层 | **公共，一份** → `~/.dsh/MEMORY.md` | 个人信息必须分离出去 |
> | `USER.md` 层 | **每个工作区一份** → `<cwd>/USER.md` | 四个人四份，不能混 |
> | 数据库 | **一个** → `~/.dsh/dreaming-memory.db` | 需要迁移 304MB |
> | `daily` | **每个工作区一份** → `<cwd>/memory/daily/` | 必须动态取 cwd，不能配死 |
> | 梦 | **只有一个，是我的梦**，素材汇总全部工作区 | 素材需带 `workspace` 来源标记 |
> | nudge 写哪 | **只写 `daily`** | 两级过滤：nudge→daily→梦境→核心 |
> | 注入 | `ctx.systemPrompt.section()` 每 step 求值 | 内容不变 cache 照命中 |
> | 系统地图 | **不做**（用户否决） | 偏门知识归档 + `memory_search` |

---

## 一、为什么要改

### 1.1 硬数据（2026-11-20 实测）

| 项 | 数值 | 问题 |
|---|---|---|
| `mayacode/MEMORY.md`（拆分前） | **96,754 字节 / 101 个二级段** | **75 段是事件流水**，其中 25 段是「梦境沉淀」 |
| 拆分后公共层 | 7,403 字节 | 目标 6 KB，仍超 1,259 B |
| SQLite 记忆库 | **304 MB** | 全量转录，无提炼 |
| 记忆工具 | 4 个，**全被动** | `memory_search` / `memory_read` / `memory_recent` / `memory_stats` |
| 梦境写入 | **无门控** | 25 段「梦境沉淀」已经在往 `MEMORY.md` 写，没人管 |

### 1.2 真正的病灶

**不是「存不下」，是「存了提炼不出来」，而且「写的没门、读的没入口」。**

```
turn/end 事件 → insertMessages() → SQLite      ← 只做这一件事
                    ↓
                没人读它
                
梦境 → 直接写 MEMORY.md                        ← 无门控，按日期堆叠
                    ↓
            96 KB 里混着事件、事实、个人信息、过时信息
                    ↓
            不注入，读了成本收益为负
```

`MEMORY.md` 被当成了归档堆。结果是：**即使去读，96KB ≈ 32k token，大半是三个月前的过时事件。
成本收益为负，不读反而是理性的。**

**而且它已经在腐烂**：拆分时发现 Hindsight（已被取代）、NTP 授时中心（已退役）、
message 渲染 bug（已修复）都还留在文件里，读到了会去连不存在的东西。

### 1.3 与两个参照系的差距

| 维度 | OpenClaw | Hermes | 我们（改造前） |
|---|---|---|---|
| 精炼核心大小 | 小 + 严格预算 | **2,200 字符 / 1,375 字符** | **96 KB** |
| 注入方式 | 每轮刷新（热） | 会话开始冻结（冷） | **完全不注入** |
| 自动召回 | Lane1 触发+加权 / Lane2 升级 | 冷召回（显式工具） | 无 |
| 写入门控 | dreaming 两道门 + 结构校验 | `write_approval` + 白名单 | **无** |
| 周期性提炼 | 无（dreaming 一天一次） | **`nudge_interval` 每 N 轮** | **无** |
| 过程性记忆 | 无 | Skills | Skills（33 个，不差） |
| 压缩前 flush | ✅ | ✅ | ✅（compaction） |

**结论：我们只在两条路上有动作 —— 「每轮无脑存」和「凌晨做梦」。中间那层
「白天边干边想、把重要的记下来」是空的。**

---


## 二、参照系拆解：Hermes 的 nudge 到底是怎么做的

读了源码 `agent/background_review.py`（1,499 行），机制如下。

### 2.1 执行模型

```
主对话 turn 结束
   ↓
AIAgent.run_conversation 起一个 daemon thread
   ↓
fork 一个 AIAgent（继承 parent 的 provider/model/credentials/缓存系统提示）
   ↓
重放对话快照，问："should any skill/memory be saved or updated?"
   ↓
直接写 memory + skill store；主对话和 prompt cache 完全不动
```

**关键：fork 继承 parent 的缓存系统提示 ⇒ 命中同一份 prefix cache ⇒ 重放几乎只算缓存读。**
这是它能"每 N 轮就跑一次完整反思"还不贵的原因。

本地模型时（GPU 争抢）自动改为 **defer**：排队到机器安静，`defer_max_age_s` 默认 1800 秒兜底。

### 2.2 工具限制：dispatch 侧白名单，不是 prompt 侧禁止

```python
review_toolsets = ["memory", "skills"] if memory_on and review_memory else ["skills"]
whitelist = {name for t in get_tool_definitions(enabled_toolsets=review_toolsets)}
whitelist |= {"read_file", "search_files"}   # 只读放行
# write_file / patch / terminal —— 拒绝
```

> **DISPATCH-side only, so the advertised `tools[]` stays byte-identical to the parent's
> (prompt-cache parity).**

**这一点极其重要：**
- 广告的工具列表**保持和父级字节相同**（否则 cache 失效）
- 但实际调用时被 dispatch 层拒绝
- **"advertising is not permission"**

**他们踩过的坑（必须抄）：**
> 最初拒绝 `read_file`/`search_files` 导致 **denial storm**：2 天里 ~142 次拒绝 +
> ~204 次 read-before-write 拒绝，饿死了整个自我改进循环。

因为模型天然要先读再改，`skill_manage` 又有 read-before-write 守卫。**只读工具必须放行。**

**防递归：**
```python
review_agent._memory_nudge_interval = review_agent._skill_nudge_interval = 0
```
fork 内部把 nudge 归零，**防止 review 自己再触发 review**。

**危险命令自动拒绝：** `_bg_review_auto_deny` 直接返回 `"deny"`，不调 `input()`（会死锁 TUI）。

### 2.3 提示词原文（这是最值钱的部分）

#### A. 双存储路由块

```
TWO distinct stores — pick the right one for each fact:
  • USER.md (target='user'): who the user is — persona, preferences, communication and
    work style, personal details they revealed, and expectations about how you should behave.
  • MEMORY.md (target='memory'): facts about the ENVIRONMENT you operate in — tool quirks,
    project conventions, config gotchas, paths and endpoints that matter.

One fact goes to ONE store, never both — writing it to both bloats both files until they
hit their size limits and crowds out the facts that matter; misrouting it puts it where the
next session won't look.

Save only facts GROUNDED in this conversation — a user message or tool result you can point
to. Never infer the user's traits, skill level, role, mood or preferences from topic, tone
or tools used, and never turn a one-off request into a standing preference (in either store)
unless the user marked it general ('always', 'from now on', 'remember') or stated a standing
like/dislike ('I hate X', 'stop doing Y'). If unsure, leave it out — a wrong fact misleads
every future session.
```

#### B. 记忆 review 提示词（极短）

```
Review the conversation above and consider saving to memory if appropriate.

[路由块]

If something stands out, save it once, in the right store, using the memory tool with the
matching target. If nothing is worth saving, just say 'Nothing to save.' and stop.
```

#### C. 什么**不该**存（`_DO_NOT_CAPTURE_BLOCK`）

```
(these become persistent self-imposed constraints that bite you later when the environment
changes):
  • Environment-dependent failures: missing binaries, fresh-install errors, post-migration
    path mismatches, 'command not found', unconfigured credentials, uninstalled packages.
    The user can fix these — they are not durable rules.
  • Negative claims about tools or features ('browser tools do not work', 'X tool is broken',
    'cannot use Y from execute_code'). These harden into refusals the agent cites against
    itself for months after the actual problem was fixed.
  • Session-specific transient errors that resolved before the conversation ended. If
    retrying worked, the lesson is the retry pattern, not the original failure.
  • One-off task narratives.
  • Unresolved failures: if the session ended WITHOUT actually finding a working method —
    you tried several things, none worked, and told the user to check manually — do NOT
    write those attempts up as a 'reliable workflow' or 'recommended approach'. That presents
    an untested sequence of failures as validated guidance a future session will trust and
    repeat. Either say 'Nothing to save', or, only if you are independently confident of a
    real working alternative, capture ONLY that alternative — never the dead ends.

If a tool failed because of setup state, capture the FIX (install command, config step, env
var to set) under an existing setup or troubleshooting skill — never 'this tool does not
work' as a standalone constraint.
```

**这五条直接命中我们的病：`MEMORY.md` 里大量 `## 某日修复` 就是"一次性任务叙事"，
而"某某不行/已废弃"这类负面断言会在环境变化后变成自我限制。**

#### D. 教训层写法（skill）

```
• Procedure first: the steps in the order they are done, with the concrete commands, tool
  calls, and decision points. Lessons and pitfalls attach to the step they affect.
• A pitfall is a generalizable rule + one clause of WHY (the mechanism), imperative.
  'Grep the test tree for the SYMBOL before widening a helper signature — hand-rolled mocks
  reimplement the old shape and fail on a shard you did not run.'
  Not a narrative of what happened this session.
• No PR/issue numbers, dates, ticket IDs, or quoted user text as content — the rule must
  stand without the incident behind it.
• The same lesson learned twice is ONE rule. Before adding, search the skill for the rule
  already stated; strengthen or clarify it rather than appending a second copy.
• Not a duplicate of what the environment already teaches: repo AGENTS.md, tool schemas.
• Always-on rules live in SKILL.md itself, whole. references/ is for depth only needed
  sometimes: a decision table, a recipe, a domain note — never '<date>-<incident>.md'.
• Fix the skill in place when it is wrong: edit the sentence that misled, do not append
  'UPDATE: actually...' underneath it.
```

#### E. 主动性的量化要求

```
Be ACTIVE — most sessions produce at least one skill update, even if small.
A pass that does nothing is a missed learning opportunity, not a neutral outcome.

'Nothing to save.' is a real option but should NOT be the default.
```

**这与我们的现状正好相反：我们是"默认什么都不写"。**

### 2.4 nudge 与 dreaming 的分工

| | nudge | dreaming |
|---|---|---|
| 频率 | 每 N 轮 | 一天一次（凌晨） |
| 延迟 | 秒级 | 数小时 |
| 上下文 | 刚结束的对话，热 | 当天碎片，冷 |
| 擅长 | **抓住"当时觉得不重要、晚上已忘了上下文"的东西** | 跨天整合、去重、叙事化 |

**两者不是替代关系。我们缺的是前者。**

---

## 三、目标架构

### 3.1 一条铁律

> **记忆的全部逻辑住在一个插件里，就是这个插件。**
>
> **`dsh-dreaming` 与 `dsh-fatatalia-memory` 合并为同一个包、同一个版本、同一个插件 id（`dsh-dreaming`）。**
> 不保留两个包、不做「一个包三个插件入口」。从用户视角，一个功能就是一个插件。
> 出问题只翻这一个仓库。

**为什么合并**：用户原话 —— 「为了实现一个功能，要同时安装两个或者更多的插件反而更乱了」。
合并的真实代价只有一个：**单一失败域**。它靠代码纪律解决，不靠拆包：

| 风险 | 缓解（代码级） |
|---|---|
| 记忆库挂了拖垮对话 | `session/event` 处理器整体 try/catch，**永不抛出** |
| 梦境失败影响记忆 | 冷路径（dream/curator）延后到首个 tick 之后初始化，失败只置标志 |
| 某个功能出问题 | 各自独立 `enabled` 开关，可单独关 |

**唯一的例外**：`@deepseek-ai/dsh-agent-preset` 是官方插件，必须用它自己的 `insert` 行声明，
无法吸收进我们的代码。这类行与本插件同处一个 `cordis.patch.yml`，不散落。

### 3.2 两个决定性事实

**① 梦是「法塔·艾莉娅」的梦 —— 只有一个，不按工作区分。**

不管谁在哪个工作区对话，都是我每天收集到的信息。所以：

- 梦境**只跑一次**，素材汇总全部工作区
- 素材必须带 `workspace` 来源标记，否则提炼时不知道某句话是谁说的
- 梦的 persona 不按工作区变化

**② 分层链路是两级的，不是一级的。**

```
原始对话 ──(nudge)──> daily ──(梦境)──> USER.md / MEMORY.md
             高频           低频
             输入脏         输入已沉淀
             只写低价值      写高价值
```

- **nudge 只写 `daily`**，不碰 `USER.md` / `MEMORY.md`
- **梦境从 daily 提炼**，是唯一能提升到核心层的通道
- 好处：nudge 写歪了最坏是多一条流水，而且还会被梦境再过一遍

### 3.3 存储位置（已定）

```
~/.dsh/
├── AGENTS.md               ← 全局纪律（dsh 注入，不动）
├── MEMORY.md               ← 公共环境事实（本插件注入，≤6KB）
├── dreaming-memory.db      ← 唯一数据库（对话 + 梦境）
├── dreaming.db             ← 待合并进上行
│
~/dsh/
├── FAMILY.md               ← 家庭共同事实（不动）
├── mayacode/               ← 代码东工作区
│   ├── USER.md             ← 个人（≤2KB）
│   └── memory/daily/       ← 流水
├── rawiyah/ nawal/ aahil/  ← 另三个工作区，同构
```

**路径解析规则（三条，不可混用）：**

| 文件 | 解析方式 | 理由 |
|---|---|---|
| `MEMORY.md` | `~/.dsh/MEMORY.md`，Config 可覆盖但**永远是一个固定路径** | 公共 → 不属于任何工作区 |
| `USER.md` | `<session.cwd>/USER.md`，**动态取** | 个人 → 跟着工作区走 |
| `memory/daily/` | `<session.cwd>/memory/daily/`，**动态取** | 流水 → 跟着工作区走 |

**`MEMORY.md` 与 `daily` 的解析方向相反，不能共用一个配置项。**
写死 `~/dsh/mayacode` 是本次要修的核心 bug（dreaming 有 4 处）。

**数据库**：`~/.dsh/dreaming-memory.db`。`~/.dsh/` 是 dsh 自己创建的稳定位置，
现有 6 个插件的库都在这里（`plant-care.db` / `memo.db` / `kart-training.db` 等），
命名规律就是 `<插件名>.db`。`~/dsh` 是我们自己建的，不稳定，不放状态。

`sessions` 表**已有 `workspace TEXT` 列**（存 `session.cwd`），`messages` 通过 `session_id`
join 即可，**不需要改表结构**。加列不改列。

### 3.4 分层与体积

| 层 | 落地 | 谁写 | 何时读 |
|---|---|---|---|
| Instructions | `AGENTS.md` | 只有人肉改 | dsh 注入 |
| **Curated core** | `~/.dsh/MEMORY.md` + `<cwd>/USER.md` | **只有梦境门控** | **本插件每 step 注入** |
| **Episodic** | `<cwd>/memory/daily/*.md` | nudge / 梦境 / 手工 | 检索工具 |
| Archive | `memory/archive/*` | 瘦身迁移 | 检索工具 |
| Prospective | memo（现有） | 手工 / 心跳 | 到期提醒 |
| Review | 梦境 + `dreaming.db` | dreaming | 从不注入 |

**体积（硬性）：**

| 文件 | 目标 | 上限（超了拒写） |
|---|---|---|
| `USER.md` | ≤ 2 KB | 4 KB |
| `MEMORY.md` | ≤ 6 KB | 10 KB |
| 单条 `memory/daily` | 无 | 无（追加式） |

### 3.5 注入机制（已验证可行）

`dsh-agent-instructions` **只认 `AGENTS.md` / `CLAUDE.md`**，文件名单一，不能配任意文件名。
所以 `MEMORY.md` / `USER.md` **不会被它注入** —— 必须本插件自己注册。

用 `dsh-system-prompt` 的 `ctx.systemPrompt.section()`：

```ts
readonly text: string | ((context: AssembleContext) => string);
```

`text` 可以是函数，**每个 step 求值一次**（agent loop 每 step 调一次 `assemble()`）。

**关于 cache 的关键纠正**：DeepSeek 的 prefix cache 按字节前缀匹配。
文件没变 → prompt 字节相同 → **cache 照常命中**。只有内容真变了，那一次才失效。
所以「每 step 读 6KB 文件」的真实成本：读盘约 0.1ms，内容不变时零额外成本。

**order 要放靠后**（`personaSuffix` 的 10200 之前），让 MEMORY 变化时失效范围最小。

### 3.6 插件内模块

```
dsh-dreaming/                     ← 合并后（保留原 id，零迁移成本）
├── index.js                      # 插件入口：装配 + 工具 + 事件 + 调度
├── lib/
│   ├── db.mjs                    # ① 落库（来自 fatatalia-memory）
│   ├── extract.mjs               # ① 提取
│   ├── search.mjs                # ② 检索工具
│   ├── nudge.mjs                 # ③ nudge 调度（新增）
│   ├── inject.mjs                # ④ 注入（新增）
│   ├── curate.mjs                # ⑤ 门控晋升（新增）
│   ├── dream-engine.mjs          # 梦境引擎（现有）
│   ├── dream-render.mjs          # 梦境渲染（现有）
│   └── store.mjs                 # 梦境存储（现有）
└── client.js                     # 浏览器端（现有）
```

**命名代价（已接受）**：一个叫「dreaming」的插件管理全部记忆，需要 README 一句话说明。
补偿是零迁移成本（插件 id、配置路径、preset 都不变）。

---

## 四、模块设计

### ④-① 落库层（已有，微调）

现状：`turn/end` → 提取 → `insertMessages`。

**唯一要加的：给每条消息补三个可检索的元数据**（不改变写入内容）：

| 字段 | 来源 | 用途 |
|---|---|---|
| `importance` | 写入时由 nudge 打分（1–10） | 检索加权 |
| `topics` | 同上，逗号分隔 | trigger 预筛 |
| `pinned` | 手工标记 | 永不衰减 |

**注意：这三列只对"提炼出的记忆条目"有意义，原始消息不打分**（原始转录 289MB，
逐条打分不现实，也没意义）。

### ④-② 检索层（已有，扩展）

现有 4 个工具保留。新增：

- `memory_search` 支持 `include_episodic` / `include_curated` 参数
- 排序公式对齐 OpenClaw：`score = relevance × decay(30d half-life) × importance`
- **不引入 embedding**（289MB 库、2 核机器，向量检索的收益抵不过成本；FTS5 trigram 已验证最慢 44ms）

### ④-③ 提炼层（新增，核心）

#### 触发条件（三个都要满足才跑）

```
1. 距上次 nudge ≥ nudgeIntervalTurns 个 turn（默认 10）
2. 距上次 nudge ≥ nudgeMinGapMinutes 分钟（默认 20，防抖）
3. 当前无主对话在跑（defer：学 Hermes，避免争抢 2 核）
```

**为什么不用 daemon thread：** dsh 插件是 JS/Node，起线程会抢 CPU。改用
**"下一个 turn 结束时顺带判断"** —— 如果该跑了，就 async 起一个子会话，
**不阻塞当前 turn 的回复**。

#### 执行方式：专用 preset（用户提的这条路，对）

```
ctx.get("agentPresets").resolve("memory-curator")
  → mount(agentCtx, id)
  → ctx.get("sessions") 建独立会话
  → 单条 user message："Review the conversation above..."
  → 拿结果 → 落盘 → 销毁会话
```

**preset 内容（`presets/memory-curator/`）：**

| 项 | 值 | 理由 |
|---|---|---|
| persona | **下面 ④-③-a 的独立提示词**（不是 dreaming 的 `dream-insight`） | 任务不同，见 ④-③-a |
| 工具 | **只有 `memory_note`（自定义）+ `read_file`** | 写工具全拒 |
| 上下文 | 裸（无人格、无 AGENTS.md、无 33 个 skills） | dreaming 的同款做法：fatatalia preset 会注入 ~25K token |
| 模型 | `provider/model` 可配，默认同主模型 | 便宜模型走摘要重放 |

#### ④-③-a nudge 必须有独立提示词（不能复用 `dream-insight`）

| | `dream-insight` | nudge |
|---|---|---|
| 输入 | 当天 daily（**已过滤**的摘要） | 最近 N 轮**原始对话**（混着工具输出、报错、闲聊） |
| 时机 | 凌晨，一天一次 | 会话中途，每 N 轮 |
| 判断对象 | 「今天留下的东西里有什么认知」 | 「刚才这几轮有没有值得长期留的」 |
| 输出 | `[{"type","content"}]` | 需要 `target` 路由 + `grounded_in` 自证 |

**输入质量差一整个量级**，同一套提示词在 nudge 环境下误判率高得多。

**定稿提示词（中文，适配我们的三层存储）：**

```
审阅上面这段对话，判断有没有值得长期留下来的东西。

两个存储，一条事实只进一个，绝不两处都写：

  USER.md   —— 这个人是谁。身份、偏好、沟通和工作习惯、他透露的私人信息、
               他希望你怎么做事。
  MEMORY.md —— 你运行的环境。工具的怪毛病、项目的约定、配置陷阱、
               重要的路径和端点。

写错地方的代价：进错库，下一轮会话根本不会去那里看；
两边都写，两个文件一起膨胀，把真正重要的事实挤掉。

只存能在这个对话里指出出处的事实 —— 一条用户消息，或一个工具结果。
不要从话题、语气、用了什么工具去推断他的性格、水平、角色、心情或偏好。
不要把一次性的请求变成长期偏好，除非他明确说了「以后」「每次都」「记住」，
或者明确表达了长期的好恶（「我讨厌 X」「别再 Y」）。
拿不准就不存 —— 一条错的事实会误导此后每一次会话。

不要存这些：
  - 环境依赖的失败：缺命令、装包报错、迁移后路径不对、凭据没配。
    这些他能修，不是持久规则。
  - 对工具的负面断言：「X 不能用」「Y 是坏的」。这会硬化成你以后
    自己引用的拒绝理由，哪怕问题早就修了。
  - 会话内已经解决的临时错误。如果重试成功了，留下的教训是重试，
    不是当初那个失败。
  - 一次性的任务叙述。
  - 没找到可行方法的失败。试了几种都没成，不要把那些尝试写成
    「推荐做法」—— 那会把一串死路包装成经验。宁可什么都不存。

输出严格 JSON，不要 markdown 代码块，不要解释：
{
  "target": "daily" | "none",
  "entries": [{"text": "一句话", "grounded_in": "原文里的那一句"}],
  "reason": "一句话说明为什么存 / 为什么不存"
}

没有值得存的：{"target":"none","entries":[],"reason":"..."}
```

**两条设计要点：**

1. **第一版 `target` 只允许 `daily`** —— 不碰 `USER.md` / `MEMORY.md`。它跑在原始对话上，
   误判率未知；核心层被污染很难察觉，日记写歪了没人看。跑一两周看它提炼的东西靠不靠谱，
   再放开。**这不是过度设计，是给不可逆的写入动作加观察期。**
2. **`grounded_in` 是自证不是装饰** —— 门控会去源文本里找这一句，找不到就丢。这是防编造的核心，
   Hermes 的注释写得很清楚：*「Store-neutral on purpose: scoped to USER.md only,
   the same guess moved to MEMORY.md.」* 规则必须对两个库同时生效。

**工具限制实现方式：✅ 已验证可行 —— preset 声明自己的 `plugins` 列表**

`@deepseek-ai/dsh-agent-preset` 的 `config.plugins` 就是该会话的子插件树。
**不列 `dsh-tool-bash` / `dsh-tool-fs` 的写工具 / `dsh-tool-web`，那些工具在这个会话里
根本不存在**——模型看不到 schema，也不会去试。

**这比 Hermes 的 dispatch 白名单更干净：**
Hermes 必须做 dispatch 拦截是因为要复用父级的 `tools[]`（cache parity）；
我们用独立 preset，**天然是不同的系统提示，不存在 cache 冲突**，也不需要处理 denial storm。

配置形态（照 `dsh-web-app/presets/cordis.patch.yml` 的样子）：

```yaml
- insert:
    - id: preset-memory-curator
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: memory-curator
        order: 10
        plugins:
          # persona = Hermes 的 review 提示词（见 2.3 A/B/C）
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: <review prompt>
          # 只读：读 MEMORY.md / 现有 skill 用
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              write: false          # 待验证是否支持
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
          # 唯一的写入口：自定义工具，只能追加到 daily / 走门控
          - id: tool-memory-note
            name: dsh-fatatalia-memory-note
```

**注意 README 的警告：**
> Presets are **not security sandboxes**: YAML and plugins can execute Host code.

preset 是**能力裁剪**，不是沙箱。真要防越权，靠的是我们自己的 `memory_note` 工具内部
做校验（见 ④-③ 输出契约），而不是指望 preset 拦住什么。

**只读必须放行**（Hermes 的 denial storm 教训）：`read_file` 要能读 `MEMORY.md` / 现有 skill，
否则模型没法"先读再改"。

**防递归：** 子会话内把 `nudge` 开关置 0。

#### 输出契约（写死，不给模型自由发挥的空间）

```json
{
  "target": "user" | "memory" | "daily" | "none",
  "entries": [
    {
      "text": "一句话事实，命令式或陈述式，不带日期/PR号",
      "importance": 1-10,
      "triggers": ["关键词1", "关键词2"],
      "grounded_in": "引用原对话里的哪一句（自检用）"
    }
  ],
  "reason": "为什么这些值得留 / 为什么没有"
}
```

**`target` 的裁决规则（代码强制，不听模型）：**

| target | 条件 | 落地 |
|---|---|---|
| `user` | 关于人的偏好/习惯/期望 | `USER.md`（过门控） |
| `memory` | 环境事实（路径/端口/约定/工具怪癖） | `MEMORY.md`（过门控 + 体积检查） |
| `daily` | 其他一切 | `memory/daily/YYYY-MM-DD.md`（直接追加） |
| `none` | 没东西可写 | 记一条"跳过"日志 |

**默认全部落到 `daily`。** 只有明确是"关于人"或"环境事实"的才考虑 curated，
且必须过门控。**这样最坏情况是多记了几条日记，不会污染精炼层。**

### ④-④ 门控层（新增）

晋升进 curated 前的四道检查，**全部是代码，不经过模型判断**：

| # | 检查 | 不通过的处置 |
|---|---|---|
| 1 | `grounded_in` 能在原文里匹配到 | 拒 |
| 2 | 不含日期/PR号/ticket号（正则） | 拒 |
| 3 | 不是负面断言（`不工作/坏了/不能用/已废弃` + 工具名） | 拒，改写为 FIX |
| 4 | 写入后文件不超过体积上限 | 拒，退回 daily |

**乐观并发：** 写入前重算文件 hash，与读取时比对，不一致则放弃本次晋升（下次再来）。

**每次晋升留痕：** 追加到 `memory/archive/curation-log.md`（谁、何时、加了什么、从哪来）。

**不做 `write_approval`（人工审批）：** 我们的瓶颈是"根本不写"，不是"写错"。
先解决写不写，再谈审不审。留配置项，默认关。

### ④-⑤ 注入层

**做法：`ctx.systemPrompt.section()`，`text` 写成函数，每 step 求值一次。**

```js
ctx.effect(() => ctx.systemPrompt.section({
  name: 'memory:curated',
  order: 10100,                       // 靠后：personaSuffix 是 10200
  text: () => readCurated(),          // 每次 assemble() 调一次
  interpolate: false,                 // 记忆里可能有 {{ }} 字面量
}), 'dsh-dreaming: curated memory injection')
```

**为什么不怕破坏 prefix cache（这是之前写错的，现已纠正）：**

DeepSeek 的 prefix cache 按**字节前缀**匹配。文件没变 → prompt 字节相同 → **cache 照常命中**。
只有内容真变了，那一次才失效，下次恢复。

所以真实成本：读 7 KB 文件约 0.1ms；**内容不变时零额外成本**。

**`order` 必须放靠后**（10100，在 `personaSuffix` 的 10200 之前）：
MEMORY 变了只影响它之后的部分，不会从 persona 那里就断掉整条缓存。

**注入什么、不注入什么：**

| 文件 | 注入 | 位置 |
|---|---|---|
| `~/.dsh/MEMORY.md` | ✅ | section `memory:curated` |
| `<cwd>/USER.md` | ✅ | section `memory:user` |
| `<cwd>/memory/daily/` | ❌ | 未审内容进 prompt 是安全问题，只走工具 |
| `memory/archive/` | ❌ | 按需 `memory_search` |

**工作区切换的处理：已确认可行 —— `text()` 能拿到当前 session 的 cwd。**

`AssembleContext` 在 `dsh-system-prompt` 里只有 `scope` / `signal` 两个字段，
但 **`dsh-agent` 通过 declaration merging 扩展了它**：

```ts
// dsh-agent/lib/types/runtime-types.d.ts
declare module '@deepseek-ai/dsh-system-prompt' {
    interface AssembleContext {
        agent?: Agent;                       // ← 关键
        modelSelection?: Readonly<ModelSelection>;
    }
}
```

而 `Agent` 上有 `session: Session`（`runtime-types.d.ts:168`），
`Session` 上有 `meta?: { readonly cwd?: string }`。

**完整链路：**

```
AssembleContext.agent?  →  Agent.session  →  Session.meta?.cwd?
```

所以 `text` 写成：

```js
text: (context) => {
  const cwd = context.agent?.session?.meta?.cwd;   // 当前会话的工作区
  return readFileSafe(join(cwd ?? '', 'USER.md'));
}
```

**`MEMORY.md` 不用 cwd**（固定 `~/.dsh/MEMORY.md`），**`USER.md` 必须用 cwd。**
两个 section 分开注册，一个跟人走，一个不跟。

**注意**：`agent` 是 optional（诊断类调用没有它）。取不到就返回空字符串，绝不抛错。

**体积守卫**：单次注入总量超过阈值（默认 10 KB）时，**只注入 `MEMORY.md` 不注入 `USER.md`**，
并在日志里告警 —— 宁可少注入，不要把 prompt 撑爆。

**失败处理（单一失败域的关键）：** 读文件失败（不存在 / 权限 / 编码）时**返回空字符串**，
绝不抛错。记忆坏了不能拖垮对话。

---

## 五、瘦身 —— ✅ 已于 2026-11-20 完成

### 5.1 实测数据

| 项 | 拆分前 | 拆分后 |
|---|---|---|
| `mayacode/MEMORY.md` | **96,754 B** / 101 段 | 1,493 B（指针文件） |
| `~/.dsh/MEMORY.md` | — | **7,403 B** |
| `mayacode/USER.md` | 1,311 B（模板 + 与 FAMILY 重复） | **2,773 B** |
| 归档 | — | `memory/archive/MEMORY-拆前-20261120-180617.md` **96,754 B，一字未删** |

**归档完整性已验证**：96,754 B / 101 段 / 72 条洞察，与原文件一致。

### 5.2 实际分类（与预估不同）

预估四类，实际也是四类，但内涵变了：

| 类型 | 数量 | 处置 |
|---|---|---|
| 环境事实 | ~40 条 | → `~/.dsh/MEMORY.md` |
| 个人信息 | ~6 段 | → `mayacode/USER.md` |
| **与 FAMILY.md 重复** | 猫/乌龟/孩子/保险/生日 | **删**，以 FAMILY 为准（原文件存了两份） |
| 事件流水 | 74 段 + 25 条「梦境沉淀」 | → 归档 |

### 5.3 拆分中发现的问题（比方案本身更重要）

**① 已经在发生的无门控写入**

第 77–101 段连续 25 条全是「梦境沉淀」，约 10 KB —— **梦已经在往 `MEMORY.md` 写，没有任何门控。**
这正是本方案要修的东西，它已经在跑，而且没人管。

**② 记录腐烂**

| 条目 | 实际状态 |
|---|---|
| Hindsight 记忆库（8888） | 已被 `dsh-fatatalia-memory` 取代 |
| 家庭 NTP 授时中心 | **2026-08-05 已退役** |
| dsh message 工具渲染 bug | 已修复 |

读到「Hindsight 在 8888」会让人去连一个不存在的东西。**删掉它们不是为了变小，是为了不误导。**

**③ 同一事实存了两份**

五只猫、乌龟、孩子生日、保险档案，`FAMILY.md` 与 `MEMORY.md` 各一份。
判据：「这是谁」→ USER；「家里事」→ FAMILY；「环境」→ MEMORY。**一条只存一处。**

**④ 「系统地图」这个分类不成立**

原本打算把「各插件管什么、端口、拓扑」抽成独立的 `SYSTEMS.md`。
**用户否决**：那属于我们这套环境的运维知识，不该变成记忆插件的概念。
→ 实际做法：真正必知的进 `MEMORY.md`，偏门的归档 + 靠 `memory_search` 查。

### 5.4 未达标项（待处理）

| 文件 | 实测 | 目标 | 状态 |
|---|---|---|---|
| `~/.dsh/MEMORY.md` | 7,403 B | ≤6,144 B | **超 1,259 B** |
| `mayacode/USER.md` | 2,773 B | ≤2,048 B | **超 725 B** |

两者都在**上限**之内（10 KB / 4 KB），但未达目标值。
可选处置：① 接受现状（在 cap 内）；② 继续压缩到目标。

**验收标准（部分待复核）：**
- [x] `MEMORY.md` ≤ 10 KB 上限
- [ ] `MEMORY.md` ≤ 6 KB 目标（现 7.4 KB）
- [x] `USER.md` ≤ 4 KB 上限
- [ ] `USER.md` ≤ 2 KB 目标（现 2.7 KB）
- [x] 归档文件完整（96,754 B）
- [x] 迁走的每一条仍可 `memory_search` 搜到

### 5.5 拆分暴露的通用判据

拆分不是分类练习，是**验证分层是否成立**。实际用到的判据：

1. **这句话不知道，我会不会立刻做错事？** 会 → MEMORY；不会，只是查起来麻烦 → 归档
2. **主语是「谁」吗？** 是 → USER / FAMILY，不是 → MEMORY
3. **这是环境事实还是这个人的事？** 环境 → MEMORY（公共）；人 → USER（各工作区独立）
4. **同一事实在别处有吗？** 有 → 删本处，以权威源为准

---

## 六、实施阶段

| 阶段 | 内容 | 风险 | 可回滚 |
|---|---|---|---|
| **P0** | `MEMORY.md` 瘦身 + 拆 `USER.md` | 极低（纯文件整理） | ✅ **已完成 2026-11-20** |
| **P1** | 修 4 处硬编码路径 + 数据库合并（`dreaming.db` → `dreaming-memory.db`） | 中（迁数据） | ✅ 先备份两个库 |
| **P2** | 插件合并：`fatatalia-memory` 代码并入 `dsh-dreaming` | 中（单一失败域） | ✅ 保留原仓库 tag |
| **P3** | 注入层：`ctx.systemPrompt.section()` 注册 MEMORY + USER | 中（改 prompt） | ✅ 配置关掉即失效 |
| **P4** | `nudge.mjs` + `memory-curator` preset | 中（新增定时逻辑） | ✅ 配置开关 |
| **P5** | 门控层 `curate.mjs`，梦境晋升走门控 | 中（可能误拒） | ✅ 日志可查，手工补 |

**顺序理由：**

- **P0 已完成** —— 纯文件操作，且用实测数据验证了分层成立（见 §五）
- **P1 先于 P2** —— 路径和库是合并的地基；先合并代码再改路径会同时动两件事
- **P3 先于 P4** —— 注入层让新写的记忆**能被看见**；先有读再有写，否则写了也没人用
- **P4 只写 daily** —— 不碰核心层，最坏是多一条流水
- **P5 最后** —— 它是唯一能让内容「提升」到核心层的通道，必须最谨慎

---

## 七、明确不做的事

| 不做 | 理由 |
|---|---|
| **系统地图独立成 `SYSTEMS.md`** | 属我们这套环境的运维知识，不是记忆插件的通用概念。**用户已否决**（2026-11-20） |
| 引入 embedding / 向量库 | 304MB + 2 核，FTS5 已 44ms；收益抵不过成本 |
| 自动注入 `memory/daily` | 未审内容进 prompt，是安全属性不是调优（OpenClaw 的边界） |
| 后台 daemon thread | JS 插件抢 CPU，改用「下个 turn 顺带判断」 |
| `write_approval` 默认开 | 瓶颈是「不写」不是「写错」 |
| 删掉任何现有 skill | 33 个 skills 是资产，是过程性记忆 |
| nudge 直接写 `USER.md` / `MEMORY.md` | 分级：nudge 只写 daily，梦境才提炼到核心（见 §3.2） |
| 按工作区拆成四个梦境 | 梦是我的，只有一个（见 §3.2 ②） |

**以下两条原本写在这里，现已推翻：**

| 原条目 | 为什么推翻 |
|---|---|
| ~~每轮刷新 system prompt 会让 prefix cache 全失效~~ | **错误**。cache 按字节前缀匹配，内容不变就命中。`ctx.systemPrompt.section()` 的 `text` 每 step 求值，文件不变时零额外成本（见 §3.5） |
| ~~改动 `dsh-dreaming` 的产物逻辑~~ | **错误**。两个插件要合并，dreaming 的产物逻辑正是要改的对象（见 §3.1） |

---

## 八、待确认的问题

**已解决：**

1. ~~`memory-curator` preset 能否只挂白名单工具？~~ ✅ 能。`config.plugins` 就是子插件树。
2. ~~`MEMORY.md` 放哪？~~ ✅ `~/.dsh/MEMORY.md`。
3. ~~数据库叫什么？~~ ✅ `dreaming-memory.db`，合并进一个库。
4. ~~要不要 `workspace` 列？~~ ✅ **已有**（`sessions.workspace`），不用加。
5. ~~系统地图放哪？~~ ✅ 不做。
6. ~~和 dreaming 的边界？~~ ✅ 合并成一个插件。
7. ~~按工作区分梦境吗？~~ ✅ 不。梦是我的，一个。

**仍未知（需要验证或决策）：**

1. **`dsh-tool-fs` 支不支持只读模式？** 若不能，只能给 `dsh-tool-fs-search` + 自定义 `read_file`。
2. **`memory_note`（非 `@deepseek-ai/*` 的自定义工具）怎么挂进 preset？** 需确认 dsh-tools 是否支持。dreaming 是宿主插件不是工具插件，路径可能不同。
3. **nudge 的 turn 计数从哪来？** `turn/end` 事件里能不能直接拿到 session 的 turn 数，还是要自己计。
4. **子会话成本怎么计量？** 每次 nudge 是一个完整 turn，会进 token 统计。需要定 `maxInputTokens` 上限。
5. **数据库迁移的具体做法**：`dreaming.db` 2.1 MB 的表结构要不要直接并进 `dreaming-memory.db`？`ATTACH` + `INSERT SELECT` 需要停写窗口。
6. **`MEMORY.md` / `USER.md` 要不要继续压到 6 KB / 2 KB？** 现在 7.4 KB / 2.7 KB，在 10 KB / 4 KB 上限内。
7. **`dream-insight` / `dream-narrative` 两个 preset 的 persona 要不要改？** 它们目前是「工程师」腔调，而梦是我的。

---

## 附：与 Hermes / OpenClaw 的取舍一览

| 机制 | 抄不抄 | 说明 |
|---|---|---|
| nudge（周期性提炼） | ✅ **抄** | 核心缺失 |
| 双存储路由（USER/MEMORY） | ✅ **抄** | 直接解决 60KB 混杂问题 |
| `_DO_NOT_CAPTURE_BLOCK` | ✅ **抄** | 直接命中我们的病 |
| grounded_in 自检 | ✅ **抄** | 防编造 |
| 只读工具必须放行 | ✅ **抄** | denial storm 教训 |
| 防递归（nudge 归零） | ✅ **抄** | |
| defer（避让主对话） | ✅ **抄** | 2 核机器必须 |
| 专用 preset 裸上下文 | ✅ **抄** | dreaming 已验证 |
| dispatch 侧白名单（cache parity） | ⚠️ 有条件抄 | 需要 cache parity 时才必要；我们若用独立 preset 则天然隔离 |
| 每轮刷新注入 | ❌ **不抄** | prefix cache 成本 |
| 冻结快照（Hermes） | ✅ 抄 | 更省，但要求文件小 |
| trigger 注入 | ⏸ 最后做 | 需 P0 完成 |
| dreaming 两道门 + 结构校验 | ✅ 抄（简化版） | 四道代码检查 |
| provenance 元数据 | ⏸ 可选 | 我们的可信边界没 OpenClaw 那么严 |
