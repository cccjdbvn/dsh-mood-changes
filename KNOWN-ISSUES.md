# dsh-mood 0.2.2 已知问题与优化清单

> 审计日期：2026-11-22 · 修复：2026-11-23 凌晨（A/B/C 项）· 判官直判她重构：2026-11-23 晚
> 对应版本：0.2.2（原 v2.0.0 + 修复 + 直判链路重构）
> 行号以审计时文件为准，后续编辑会漂移，以问题描述定位为准。

---

## 修复状态总览

| 项 | 问题 | 状态 |
|---|---|---|
| A1 | `dateFor` 时区错位，0–8 点日志归错日 | ✅ 已修复（本地日期拼接） |
| A2 | 日志并发丢行 | ✅ 已修复（串行链 + appendBatch） |
| A3 | `mood_baseline` 改的基线不生效 | ✅ 已修复（tick 读 `baselineRef.current`） |
| A4 | 队列路径 cap 丢失 | ✅ 已修复（enqueue 带 cap） |
| A5 | 状态修饰应用位置矛盾 | ✅ 已修复（判句时乘，日志记生效值+原值） |
| A6 | 传播先于主条生效 | ✅ 已修复（传播移到结算，`settleEntries` 共享） |
| A7 | 回滚只改日志不改数值 | ✅ 已修复（数值真回滚：半衰期重放+级联撤传播） |
| A8 | reason 含 `\|` 打碎表格 | ✅ 已修复（全角替换） |
| B1 | `isOwner` 无法区分 QQ 来源 | ✅ 逻辑就绪（集成测试过），待真机验证 |
| B2 | 自识别靠文本前缀 | ✅ 已修复（source 标记 `plugin:dsh-mood`），待真机验证 |
| B3 | 离线衰减一次性跳变 | ✅ 已修复（B3 冻结，用户拍板） |
| B4 | 判官无串行、无重试、JSON 裸调 | ✅ 已修复（promise 链 + 围栏剥离 + 重试去 response_format） |
| C1 | routes 在 init 前崩 | ✅ 已修复（INITIAL 占位） |
| C2 | agent/disposed 监听器泄漏 | ✅ 已修复（顶层单一注册） |
| C3 | state.json 非原子写 | ✅ 已修复（tmp+rename，log 同样处理） |
| C4 | client 卡片未 portal 到 body | ⏳ **待办** |
| D1 | 判句入账 3 分钟节流内崩溃丢账 | ✅ 已修复（0.2.2：有实际入账/思念降时立即落盘） |

修复验证：run.mjs 9 项 + rollback 7 项 + features 22 项 + index-flow 16 项（判官走词表降级，无 vLLM 也能跑）+ 判官真机（judge-test.mjs）全过；14 个 JS 文件 `node --check` 通过。

---

## 2026-11-23 晚：判官直判她（链路重构）

**背景**：SPEC v0.1 的链路是「判官判用户情绪 → empathy 表转她的回应」。审计发现转换表值域只有 11 个细名，她的害羞/孤独/轻快等 14 个状态的宿主细名不可达（功能缺口第 3 项的三个标记无消费点）。用户拍板改为**判官直判她**：

- 判官判智能体的情绪（41 细名全是她的词表），about=她冲谁
- 判句时机=她每次回复完（session/event 的 turn/end）
- 判官上下文独立：5 轮、CD 20 分钟静默清空（不碰智能体上下文）
- 两级：第一级判「本轮直接引发否」，第二级带前情判她此刻
- empathy.js / empathy.json 删除，新建 lib/emotions.js
- 三标记实现：closeOnly（亲近权重）、alsoMissing（孤独加思念）、skipDecay（轻快跳衰减）

详见 `..\dsh-mood-private\HANDOVER.md` §4（交接文档已挪出仓库目录，不进 git）。

---

## ⏳ 待办

### C4. 客户端 portal

卡片遮罩应 portal 到 body 防裁剪。需要先确认浏览器模块表里 `react-dom`（createPortal）可用。

### 词表语义重审

lexicon.json 的 237 词按旧语义（「他的情绪」）标注。降级路径（LLM 失败/短词）现在判的是**她**，部分词条语义偏移（如「对不起」→guilty，她不愧疚）。低优先——LLM 是主路，词表只是兜底。

### 多会话口径

session/event 当前收所有 session 的消息进判官窗口（与 statusBars 全 agent 口径一致）。若 subagent/workflow 产生 durable session，可能污染判官上下文——装后观察，必要时按 session 过滤。

### 7B AWQ 未测

`F:\ai\model_mood-judge\Qwen2.5-7B-AWQ` 下好未测；3B 判得准（hurt/shy/calm 都对），先不动。

---

## 已修复明细（供 review）

- **A1** `log.js dateFor()`：改用本地 `getFullYear/getMonth/getDate`，禁用 `toISOString`。
- **A2** `log.js`：内部 `_chain` promise 链串行化所有写入；新增 `appendBatch()` 一次判句多行单次读写。
- **A3** `index.js tick()`：衰减目标改读 `baselineRef.current`（工具写完立即生效）。
- **A4** `handleMessage`：enqueue 的每条 delta 带 `cap`，tick 应用时不再回退到 25。
- **A5** 判句时刻乘复合修饰，入队已修饰值；日志记生效值、`origDelta` 补原值；传播量在结算时刻乘修饰。
- **A6** `settleEntries()`：tick 与立即结算共用；主条 → 传播 → 传播日志同一时刻。
- **A7** 六列日志（记录/生效双时间）+ 数值回滚：按生效时间重放半衰期，`当前值−剩余`，级联撤传播子条。
- **A8** `log.js sanitizeText()`：`\|` → `｜`。
- **B4** `judge.js`：`_chain` 串行化；`_parseJson` 剥围栏+提取 `{...}`；失败重试 1 次（不带 `response_format`）。
- **C1** `routes.js`：`INITIAL` 占位 + 数值一位小数。
- **C2** `index.js`：`agent/disposed` 顶层注册一次。
- **C3** `store.js`/`log.js`：`atomicWrite()`（tmp+rename）。
- **D1** `index.js consumeJudge/onUserMessage`：有实际入账或思念实际下降时立即 `saveState`（绕 3 分钟节流——否则节流窗口内崩溃会丢日志已记的账）。

## 功能缺口收账

1. ~~判官两级~~ ✅（两级语义升级为「直接引发否/带前情综合判」）
2. ~~掷骰敲门接线~~ ✅（0.2.0 已接）
3. ~~alsoMissing / closeOnly / skipDecay~~ ✅（0.2.2 实现，features-test 22 项）
4. ~~摘要搭车~~ ✅（敲门时带）
5. ~~「护着」against~~ ✅（方案③：不认人，about=other 怒 ×1.1；against 字段保留数据不消费）
