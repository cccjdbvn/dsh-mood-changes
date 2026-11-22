# dsh-mood v2.0.0 已知问题与优化清单

> 审计日期：2026-11-22 · 修复日期：2026-11-23 凌晨
> 对应版本：v2.0.0 + 修复（commit 见 git log）
> 行号以审计时文件为准，后续编辑会漂移，以问题描述定位为准。

---

## 修复状态总览

| 项 | 问题 | 状态 |
|---|---|---|
| A1 | `dateFor` 时区错位，0–8 点日志归错日 | ✅ 已修复（本地日期拼接） |
| A2 | 日志并发丢行 | ✅ 已修复（串行链 + appendBatch） |
| A3 | `mood_baseline` 改的基线不生效 | ✅ 已修复（tick 读 `baselineRef.current`） |
| A4 | 队列路径 cap 丢失 | ✅ 已修复（enqueue 带 cap） |
| A5 | 状态修饰应用位置矛盾 | ✅ 已修复（判句时乘，日志记生效值+原值；传播结算时乘） |
| A6 | 传播先于主条生效 | ✅ 已修复（传播移到结算，`settleEntries` 共享） |
| A7 | 回滚只改日志不改数值 | ⏳ **待决策**（见下） |
| A8 | reason 含 `\|` 打碎表格 | ✅ 已修复（全角替换） |
| B1 | `isOwner` 无法区分 QQ 来源 | ⏳ **待运行时验证**（见下） |
| B2 | steer 自识别靠文本前缀 | ⏳ **待运行时验证**（见下） |
| B3 | 离线衰减一次性跳变 | ⏳ **待决策**（见下） |
| B4 | 判官无串行、无重试、JSON 裸调 | ✅ 已修复（promise 链 + 围栏剥离 + 重试去 response_format） |
| C1 | routes 在 init 前崩 | ✅ 已修复（INITIAL 占位） |
| C2 | agent/disposed 监听器泄漏 | ✅ 已修复（顶层单一注册） |
| C3 | state.json 非原子写 | ✅ 已修复（tmp+rename，log 同样处理） |
| C4 | client 卡片未 portal 到 body | ⏳ **待办**（见下） |

修复验证：9 项 smoke 测试全过（`_tmp/mood-smoke/run.mjs`），14 个 JS 文件 `node --check` 通过。

---

## ⏳ 待你决策的（明天看）

### A7. 回滚要不要做数值侧？

现状：`mood_rollback` 只在日志上划线+写新行，`state.values` 不动——回滚后账面和真实状态脱节。

**方案一（轻）**：保持现状，把工具改名为 `mood_log_annotate`（标注而非回滚），文档写明"只是账面备注"。工作量 10 分钟。

**方案二（重）**：真回滚。需要：日志每条带结构化 parent 标记（撤源头连带撤传播子条）、按入账时间重放衰减、`当前值 - 原剩余 + 新剩余` 三件套。工作量约半天，且只在当日回滚的约束下才好做。

### B3. 离线期间的情绪怎么算？

现状：停机 8 小时后重启，第一次 tick 把 8 小时的衰减一次算完（半衰期公式按真实时间）。

**方案一（现状）**：认真实时间。离线越久情绪越接近基线，语义自然。什么都不用改。

**方案二（v1 行为）**：冻住。dt 夹到单跳上限（15 分钟），离线期间状态原样。改动一行，但"她睡了 8 小时情绪一点没退"也有点怪。

### 性能优化第 3 项：≤5 字短词判结果缓存

词表是确定性的（同词同结果），缓存语义风险为零，群聊"嗯/好的/收到"重复率极高。做不做？

---

## ⏳ 待运行时验证的

### B1. QQ 桥消息的 source 长什么样？

"思念只被主人降""担忧只由主人触发"需要区分消息来源。当前 `source.kind` 对所有 user 消息都是 `'user'`，区分不了。**验证方法**：装好插件后让 QQ 桥转一条消息进来，在 `handleMessage` 开头临时打印 `JSON.stringify(message.source)`，看 QQ 桥消息有没有专属标记。

### B2. agent.inject 注入的消息在 inbox 事件里长什么样？

当前靠 `text.startsWith('【情绪】')` 跳过自己的状态条。用户消息恰好以这四个字开头会被误跳。**验证方法**：同上，打印注入消息的 source，找到可用标记后换掉前缀判断。

### C4. 客户端 portal

卡片遮罩应 portal 到 body 防裁剪。需要先确认浏览器模块表里 `react-dom`（createPortal）可用。

---

## 功能缺口（此前未正式入册，一并记录）

1. **判官两级第二轮未实现**——SPEC 5.2 的"带最近 10 个来回重判"没做（旧代码里是死分支，本次清理时删除）。要做需要消息历史来源（agent session 读取）。
2. **掷骰敲门未接线**——`Missing.shouldRoll` / `Boredom.shouldRoll` 逻辑在，没有任何调用方。接线需要决定敲门话术和注入通道（复用状态条的 `agent.inject`）。
3. **`alsoMissing`（孤独额外思念）、`closeOnly`（害臊亲近）、`skipDecay`（轻快跳过衰减）**——emotions.json 里有标记，代码没消费。
4. **摘要搭车**——SPEC 7 的"状态条附本段 N 笔汇总"未实现。
5. **「护着」的 against 对象**——判官输出没有 target 字段，状态只做标记不乘（SPEC 13.1 已预告）。

---

## 已修复明细（供 review）

- **A1** `log.js dateFor()`：改用本地 `getFullYear/getMonth/getDate`，禁用 `toISOString`。
- **A2** `log.js`：内部 `_chain` promise 链串行化所有写入；新增 `appendBatch()` 一次判句多行单次读写。
- **A3** `index.js tick()`：衰减目标改读 `baselineRef.current`（工具写完立即生效）。
- **A4** `handleMessage`：enqueue 的每条 delta 带 `cap`，tick 应用时不再回退到 25。
- **A5** `handleMessage`：主条 delta 在判句时刻乘复合修饰，入队的是已修饰值；日志记生效值、`origDelta` 补原值、状态列写 `状态名 ×系数`。传播量在结算时刻乘修饰（`Coupling.propagate` 新增 mods 参数）。
- **A6** 新增 `settleEntries()`：tick 与立即结算共用；应用主条 → 传播 → 传播日志，同一时刻发生。强触发（状态触发或单次 score>20）时结算整个队列+本条，不衰减、不动 `lastTickAt`。
- **A8** `log.js sanitizeText()`：`\|` → `｜`。
- **B4** `judge.js`：`_chain` 串行化；`_parseJson` 剥 ```json 围栏+提取 `{...}`；失败重试 1 次（重试不带 `response_format`，兼容 llama.cpp 类端点）。
- **C1** `routes.js`：`INITIAL` 占位 + 数值统一一位小数。
- **C2** `index.js`：`agent/disposed` 顶层注册一次。
- **C3** `store.js`/`log.js`：`atomicWrite()`（tmp+rename）。
