# dsh-mood 1.0.2 已知问题与优化清单

> 审计日期：2026-11-22 · 修复：2026-11-23 凌晨（A/B/C 项）· 判官直判她重构：2026-11-23 晚 · E1 传播回声修复：2026-11-23 深夜 · E2 状态回滚 / E3 级联：2026-11-23 深夜 · E4 无聊工具窗口：2026-11-23 夜 · E5 胶囊槽位：2026-11-23 夜 · E6 回滚撞车：2026-11-24 凌晨 · E7 批量回滚+标记：2026-11-24 凌晨 · E8 无聊互斥补漏：2026-11-24 上午 · E9 面板变化列显示：2026-11-24 上午 · E10 注入消息缺 id 卡死归档：2026-11-24 下午 · E11 /tick 调试核算接口：2026-11-24 下午 · E12 主动核算工具：2026-11-24 下午 · E13 注入只发她的会话：2026-11-24 下午 · E14 按工作目录自动认家：2026-11-24 下午 · E15 shy 标签改「害羞」：2026-11-24 下午 · E16 shy 亲近权重 乐 0.6/惧 0.4：2026-11-24 下午 · E17 面板日志按时间降序：2026-11-24 下午 · E18 面板显示上次掷骰：2026-11-24 晚 · E19 设置页（插件配置/运行参数/情绪基线）：2026-11-24 晚 · E20 设置页兜底注册独立 section：2026-11-24 晚 · E21 设置页改卡片墙：2026-11-24 晚 · E22 横向页签+配色+六情半衰期：2026-11-24 晚 · E23 衰减分章（六情 / 思念与无聊）：2026-11-24 晚 · E24 主人判定（桌面默认主人 / QQ 认主人）：2026-11-24 晚 · E25 QQ 桥的消息读给判官：2026-11-25 凌晨 · E26 判官判定记录 + 入账门槛 0.10：2026-11-25 上午 · E27 判句输入按来源改写 + 时间排序 + 状态条只在她在场时注入：2026-11-25 上午
> 对应版本：1.0.2（0.2.x 系列 + E1–E27；版本号 1.0.1 → 1.0.2）
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
| E1 | 传播源不唯一：副情绪也向外传播并回传主情绪 | ✅ 已修复（0.2.3：每笔只由落账值最大的 base 传播，且用实际落账值） |
| E2 | 状态无法回滚（数值回滚了状态还挂着） | ✅ 已实现（0.2.4：mood_rollback 支持 block=状态） |
| E3 | 判句整体回滚不撤它触发的状态 | ✅ 已实现（0.2.5：纯删除且主条全划线 → 连带撤状态） |
| E4 | 无聊对工具调用只降一次/小时 | ✅ 已实现（0.2.6：1 小时滚动窗口，第 5 次调用追加第二次 ×0.6；两次都 ×0.6） |
| E5 | 胶囊槽位与 breezetts 语音条平局（都是 order 20），重启后换位 | ✅ 已修复（0.2.7：胶囊改 order 25，固定在语音条后面） |
| E6 | 回滚按时间找行时误中同分钟的回滚替换行/传播子行 | ✅ 已修复（0.2.8/0.2.9：pass 1 跳过「回滚」「传播」行） |
| E7 | 误判波要一笔一笔调回滚（今晚十连调） | ✅ 已实现（0.2.10/0.2.11：范围清扫 / 列表批量 / **标记机制 mark→executeMarked**） |
| E8 | 无聊第二次衰减无视跨类型 30min 互斥 | ✅ 已修复（0.2.12：追加衰减只跳同类型 1h CD，被消息压住时排队、CD 过后补发） |
| E9 | 面板日志「变化」列只有数值，看不出是哪一块 | ✅ 已实现（0.2.13：显示块名+带符号数值「怒+5」「无聊-12」；状态行「—」、回滚行「回滚+0」；日志文件仍写纯数值） |
| E10 | 状态条/敲门注入的 `user/message` 缺 `id`，host 存储校验失败 → 世界归档整份卡死 | ✅ 已修复（0.2.14：`_post()` 补 `id: randomUUID()`；历史两条缺 id 的旧会话仍卡着，改 host 会话文件属数据手术，未做） |
| E11 | 核算 15 分钟一次，调试时干等、不知道 tick 有没有抛错 | ✅ 已实现（0.2.14：`GET /dsh-mood-changes/tick` 立刻核算一次，返回 `{ok, lastTickAt, values, queue}`；出错回 `{ok:false, error}`） |
| E12 | 判句入账要等 tick（或强触发），模型没法主动结算；想撤一笔未结算的判句也找不到日志行 | ✅ 已实现（0.2.15：`mood_settle` 工具，模型主动启动、无冷却，只结算队列不衰减；空队列 `settled:0`） |
| E13 | 状态条/敲门注入给所有 live agent，工作会话也收到她的情绪 | ✅ 已修复（0.2.16：只发给 `targetSessionId` 对应的 agent（`agent.id` 即 SessionId）；未配时保持全量旧行为） |
| E14 | 换会话后 `targetSessionId` 就过时，得手动改配置 | ✅ 已实现（0.2.17：`targetWorkspaceDir`——按目录找最新创建、未归档、活着的根会话，投送/判句/降值都认它；换会话自动跟上） |
| E15 | 细情绪 `shy` 的中文标签是「害臊」，与它的状态名「害羞」不一致，日志/注入摘要读着别扭 | ✅ 已修复（0.2.18：`data/emotions.json` 的 `shy.label` 改「害羞」；纯文案，权重/状态/上限未动） |
| E16 | 害羞对亲近的人只给乐 0.2 / 惧 0.8，乐的比重太低 | ✅ 已实现（0.2.19：`shy.weights` 改 **乐 0.6 / 惧 0.4**；`closeOnly` 不动，非亲近分支仍全部落惧） |
| E17 | 胶囊日志按块反转文件顺序，最新的一笔不一定在最上面，读着得来回找时间 | ✅ 已实现（0.2.20：`/log` 响应按「记录时间」降序、跨块合并；同一分钟保持文件先后；日志 .md 排序不动） |
| E18 | 胶囊面板看不到思念/无聊的掷骰状态：不知道上次掷没掷、中没中、多久前 | ✅ 已实现（0.2.21：面板加「上次掷骰」一行——思念/无聊各显示「掷中/未掷中 · N分钟前」，从没掷过写「未掷过」，夜间写「夜晚停掷」；`shouldKnock` 记 `lastRollHit`，`/state` 透出 `lastRoll`/`lastRollHit`/`rollNightPaused`） |
| E19 | 设置界面看不到插件配置（客户端不再自动生成插件配置页），思念/无聊的增速、衰减 CD、情绪基线也没有可改的入口 | ✅ 已实现（0.2.22：插件自己注册 `settings.plugins.tab` 的「情绪插件」页——① 插件配置（profile，`configEditor` 写）② 运行参数（`mood/tuning.json`，**即时生效**：增速/衰减系数/冷却/夜间窗口）③ 情绪基线（`mood/baseline.json`）；三条本机接口 `/config` `/tuning` `/baseline`） |
| E20 | 只注册 `settings.plugins.tab` 时，如果「插件」section 不显示，整页就看不见（用户给《DSH插件设置页改造配方》：要再注册独立 `settings.section`） | ✅ 已修复（0.2.23：同时注册独立 `settings.section`（id `dsh-mood-changes`、order 29，左侧「情绪插件」一整页）与 `settings.plugins.tab`（order 90）；注册包在 `ctx.inject(['slots'])` + `setTimeout(0)` 里，slot 不存在时兜住异常） |
| E21 | 设置页把十多个字段平铺成一张长表单，不像世界控制台那样分类，找一项要滚 | ✅ 已实现（0.2.24：改成卡片墙——插件配置 / 增速 / 衰减 / 冷却 / 夜间 / 情绪基线 各一张卡片，卡上显示现状摘要；点进去单独改、单独保存、单独返回） |
| E22 | 卡片墙还是不像世界控制台；页面太单调；衰减类看不到六情自身衰减速度 | ✅ 已实现（0.2.25：改成顶部横向页签（照世界控制台「概览/人设/…」），一类一块，每类一个主题色（页签下划线/左彩条/输入框边框/保存按钮）；衰减类加**六情半衰期** 6 项——乐 5h / 悲 10h / 怒 6h / 惧 12h / 惊 2.5h / 厌 30h 可调，`MoodPool.decay` 与回滚重放都读 tuning） |
| E23 | 衰减类里六情半衰期和思念/无聊的系数混在一起，像一锅 | ✅ 已实现（0.2.26：衰减再分两章——「六情衰减」（六个半衰期）与「思念与无聊」（降值/消息/工具系数），章节标题带虚线分隔；保存仍整块提交） |
| E24 | 主人判定不够明确：QQ 端要按昵称认主人，桌面端输入框来的消息应该默认就是主人 | ✅ 已修复（0.2.27：`ownerFromSource` 提到模块顶层并导出——**非插件注入的消息一律当主人**（桌面端不管 kind 是 user/空/其它）；**QQ 端只认 QQ 桥私聊 + 昵称在 `ownerNames` 里**，群聊/别人/摘要都不算） |
| E25 | QQ 那边说的话判官看不到：`qq_bridge_send` 是工具调用，不进 `assistant/message`；`plugin:dsh-qq-bridge` 注进来的消息也没被读进判句 | ✅ 已实现（1.0.1：**只读，不拦截**——`tools/result` 里读 `qq_bridge_send` 的 `text` 参数，`turn/end` 时拼成「她（QQ 发出）：…」喂判官；QQ 桥注入的正文原样读进判句；只在工具里说话的一轮也算她说了。内容一字不改，只有 2000 字长度上限防炸上下文） |
| E26 | 判了「没变化 / 没过门槛 / 调用失败」时一个字都不留，事后只能翻 vLLM 日志猜 | ✅ 已实现（1.0.2：`lib/judge-log.js` —— 判官每次调用落一行 JSON 到 `worldDir/mood/judge-log/YYYY-MM-DD.jsonl`，含 round / clear / confidence / emotions / applied / states / skipped / verdict；写失败只 warn。同时按用户要求把**入账门槛 0.15 → 0.10**，`judge.js` 的过滤、词表兜底、`data/judge-prompt.md` 提示词、`lexicon.json` 注释一起改） |
| E27 | 判句输入不区分来源、不分先后：生活线提醒、QQ 消息、harness 脚手架混在「用户：」里；QQ 的 `[QQ · 私聊]` 与「（回 QQ 用…）」也照抄；状态条夜里排队，早上一起冒出来 | ✅ 已实现（1.0.2：`judgeLineFor(kind,text,isOwner)` 按来源改写——QQ 拆前缀/指令行、主人 →「用户：」别人 →「昵称：」；生活线 →「【生活线】」；`runtime-context`/`time-context` 不进判句；`buildRoundLines(events, reply)` 把这一轮所有入站按时间排序、回复放最后；状态条只在**她 30 分钟内有过消息**时才注入，否则整夜不排队） |

修复验证：run.mjs 9 项 + rollback 7 项 + rollback-collision 8 项（E6 端到端，含传播行场景）+ features 22 项 + index-flow 19 项（判官走词表降级，无 vLLM 也能跑；含 E1 回归 2 项、E25 纯工具轮 1 项）+ baseline-watch 6 项 + state-rollback 15 项（E2 端到端）+ state-cascade 15 项（E3 端到端）+ boredom-window 18 项（E4/E8 端到端）+ batch-rollback 20 项（E7 端到端）+ mark-rollback 25 项（E7b 端到端）+ change-text 28 项（E9 端到端，含路由响应）+ statusbar-id 13 项（E10：id/UUID/唯一性/source/容错）+ tick-route 13 项（E11：注册/成功/错误/不传 onTick 兼容/state 回归）+ settle 30 项（E12：入队→主动核算→落盘→空队列→核算后回滚→无冷却→兼容）+ inject-scope 9 项（E13：状态条/敲门只发她、未配时全量、id/source 不回退）+ workspace-home 12 项（E14：选对家/排除归档与工作目录/subagent/fork/换会话跟上/没有家不投）+ log-order 13 项（E17：/log 按记录时间降序、同分钟保持文件序、块筛选仍降序、日志 .md 排序不动、无记录日期空数组）+ roll-status 37 项（E18：掷骰记 lastRollHit、/state 透出、旧 state 兜底、夜晚停掷边界）+ tuning 57 项（E19：运行参数归一化/单位换算/夜间窗口/参数化行为/落盘；/tuning 与 /baseline 的 GET/POST、白名单、400、403；E22 加六情半衰期 7 项）+ owner 13 项（E24：桌面端各种 kind、QQ 私聊/群聊/legacy kind/未唤醒摘要）+ qq-judge-input 22 项（E27：QQ 前缀/指令行清洗、主人→用户、别人→昵称、群聊、生活线、脚手架不进判句、时间序、去重、纯工具轮）+ 判官真机（judge-test.mjs）；16 个 JS 文件 `node --check` 通过（合计 411 项断言）。

E15 为纯文案：`data/emotions.json` JSON 解析通过、41 条细名查重通过（无新增重名），未新增断言。
E16 是权重表改动（数据），判句/传播/衰减逻辑未动；`features-test.mjs` 22 项仍全绿（含 closeOnly 两个分支）。
E17 只改显示顺序（`/log` 响应排序 + client 去掉旧反转），日志 .md 的排序与内容都没动；全量 18 个脚本 281 项断言全绿。
E18 只加记录字段和显示，不改掷骰概率/阈值/夜间窗口：`lastRollHit` 在 `shouldKnock` 里顺手记，`/state` 多三个字段，面板多一行小字；全量 19 个脚本 318 项断言全绿。
E19 把原来写死的运行参数抽成 `lib/tuning.js`（默认值 = 旧常量，不配文件行为不变），Missing/Boredom 的 tick/drop/onToolCall/shouldKnock 加可选 `opts`；设置页分「插件配置 / 运行参数（增速·衰减·冷却·夜间）/ 情绪基线」；全量 20 个脚本 368 项断言全绿。
E20 只改客户端注册方式（同时注册 `settings.section` + `settings.plugins.tab`，包 `ctx.inject(['slots'])`），未新增断言；重启后查 `settings.section` 的 occupants 应出现 `dsh-mood-changes`。
E21 只改设置页组件布局（平铺表单 → 卡片墙 + 分组详情页），接口与保存逻辑不变，未新增断言；全量 20 个脚本 368 项断言仍绿。
E22 把六情半衰期参数化（`tuning.mood.*HalfLifeMs`，默认 = 旧常量）：`MoodPool.decay` 多收一个 `opts`，回滚重放的剩余量也读 tuning；设置页改横向页签 + 主题色。tuning-test 加 7 项（半衰期可调/单位换算/拒绝 0/decay 实测/默认回落），全量 20 个脚本 375 项断言全绿。
E23 只改设置页衰减块的排版（分两章），接口/保存/断言都没动；全量 20 个脚本 375 项断言仍绿。
E24 把主人判定抽成模块顶层 `ownerFromSource(kind, text, names)` 并导出：非插件注入一律主人，QQ 桥注入只认私聊 + `ownerNames` 命中；新增 owner-test 13 项，全量 21 个脚本 388 项断言全绿。
E25 只在判句输入侧加读法（`judgeTextFor` / `qqSendTextOf` / `buildRoundLines` 三个导出纯函数），QQ 桥的收发链路一行没碰：`tools/result` 多看一眼 `qq_bridge_send` 的 `text` 参数，`turn/end` 多拼一行「她（QQ 发出）」，QQ 注入的正文原样进判句（唯一处理是 2000 字上限）。新增 qq-judge-input 21 项 + index-flow 加 1 项（纯工具轮也判句），全量 **22 个脚本 410 项断言**。

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

### 判官模型选型：7B 起，3B 及以下不建议（2026-11-25 用户声明）

本机 2026-11-23 夜起跑 `Qwen2.5-7B-AWQ`（vLLM，端点 `127.0.0.1:8000`），效果比 3B 稳：反讽、语气强度、`about`（对谁）都判得更准。**不建议走 3B 及以下**——短句、反讽、强度容易判偏，判歪比判不出来更伤账；宁可让它给 `clear:false`、走词表兜底。7B AWQ 约 6GB 显存；没有 GPU 就别降级硬跑，直接用词表或换更小的云端端点。旧的 3B 模型仍在 `F:\ai\model_mood-judge\`，只作回退。

### fiber 重载数据热载不可靠（2026-11-23 深夜实测）

disable→enable 后，`/dsh-mood-changes/state` 路由仍应答**旧 apply 闭包的冻结 state**（盘上已清 states、路由仍返回旧值）——HANDOVER 坑 5 的「数据文件不需要重启」在此场景不成立（路由/判句/工具闭包全部存疑）。手改 state.json 后**必须重启 DSH** 才保险。另：profile `cordis.patch.yml` 带 BOM 会卡死 plugin_manager 的 set 操作（YAML 解析报错），已剥 BOM（备份 `.bak-20261123`）；下次遇到同样报错先查文件头 EF BB BF。

---

## 2026-11-23 深夜：E1 传播回声（左脚踩右脚）

**症状**（情绪日志 2026-11-23 21:49/21:54 两笔「委屈」可见）：一笔判句拆成多条 base delta 后（hurt = 悲 0.8 / 怒 0.2），**每条 delta 都各自向外传播**——只有 2.8 的怒也传播，还按矩阵（anger→sad +0.05）**传回悲**，并被「委屈着 sad×1.2」状态放大。悲传怒、怒传悲，互为回声。

**根因**：`settleEntries` 的传播循环遍历 `entry.deltas` 的**全部**条目，而 SPEC 5.6 的语义是「**主情绪**的分量传给相关情绪」。另外传播量用的是入队请求值 `d.delta`，不是实际落账值（被 cap/0/100 夹过），值贴池边时会传出从未落地的量。

**修复**（0.2.3）：每笔 entry 只让**实际落账值最大的那条 base** 传播，传播源改用 `actual`。副情绪不再传播，回声消失。传播行格式/生效时刻不变，回滚级联（按父块名+同生效时刻匹配）不受影响。回归断言进 `index-flow-test.mjs`（场景 A：hurt 词表降级后日志不得出现「由 怒 传播」）。

---

## 2026-11-23 深夜：E2 状态回滚（新能力）

**背景**：状态触发行在判句时刻写日志、独立于数值账，所以回滚引发它的情绪条目并不会撤掉状态——误判触发的「委屈着」会继续放大后续入账 1 小时，没有撤销手段。

**实现**（0.2.4）：`mood_rollback` 的 block 枚举加 `状态`。回滚一条触发行 = 账面划线 + 修正当前生效状态：

- 今天没有剩余的未划线触发 → 从 `state.states` 删除该状态；
- 还有更早的触发（刷新时长的情况）→ `until` 回退到「剩余触发里最晚一次 + 该行自己的时长」，回退后已过期则照删；
- 剩余触发的判定用 `log.read`（天然跳过已划线行），时长从状态行的 `60min` 列解析；
- `newDelta` 对状态无意义，不支持；
- 替换行的「连带 N 笔传播」注记改为有级联才写（状态回滚不写）。

注：skipDecay 已消耗的跳数不回补（计数不可逆）；回滚限当日，凌晨 0–4 点触发的状态行在昨天的文件里，同样受当日限制。

---

## 2026-11-23 深夜：E3 判句整体回滚 → 状态级联撤销

**背景**：用户确认期望「触发该状态的那一条被回滚，状态接着回滚」。此前 E2 只提供显式回滚（block=状态），回滚判句的数值主条不会动状态。

**实现**（0.2.5）：数值回滚路径加级联，条件三缺一不可：

1. **纯删除**（不填 `newDelta`）——改值回滚（newDelta≠0）= 判句仍成立（只是改大小），状态保留；
2. **该判句的所有主条都已划线**（同记录时间 + 同 evidence 的六情主条全部不再站立）——只撤一条 base 时判句部分成立，状态保留；
3. 匹配到**同一记录时间的 `触发：<label>`** 状态行——级联划线 + 走 E2 的状态修正（剩余触发 → 回退时效；无 → 清除）。

级联会写一条「连带：<label> 判句已整体回滚」的替换行留痕。状态修正逻辑（E2/E3 共用）抽成 `settleStateAfterRollback()`。

边界：判句还带出的 alsoMissing 思念行（「孤独：她开始想主人」）**不**级联——思念涨值不在六情账里，需要的话单独回滚思念块那条。

---

## 2026-11-23 夜：E4 无聊·工具侧窗口衰减（机制变更）

**用户拍板的语义**：工具调用按 **1 小时滚动窗口**计数，每窗口最多两次衰减，**两次都是 ×0.6**（原单次 ×0.5 → 改为 ×0.6）：

- 窗口内第 1 次调用 → 正常衰减 ×0.6（照旧受冷却约束：同类型 1h / 跨类型 30min）；
- 窗口内第 5 次调用 → **追加**第二次衰减 ×0.6，跳过冷却；
- 第二次衰减后窗口清零（下个调用是新窗口的第 1 次）；第二次**不锚定** `lastToolAt`（纯加成，不干扰冷却节奏）；
- 计数照数被冷却挡住的调用（第 1 次没衰减也照样往 5 数）；
- 消息侧（×0.7）与互斥冷却完全不动；仍只认她会话的工具调用。

**实现**：`Boredom.onToolCall()`（boredom.js）替代 handler 里的 `drop(…,'tool')`；state 新增 `toolWindowStart`/`toolWindowCount`（init 回填，旧文件兼容）；日志两次衰减分两行，reason 分别为 `做了件事（name）×0.6` 和 `做了件事（name）×0.6（1小时内第5次）`。注意 ×0.6 是**值乘系数**（如 60→36），不是减 60%。

---

## 2026-11-24 上午：E9 面板「变化」列显示块名（用户需求）

**需求**：点开胶囊看到的日志里，「变化」列原来只有一个数值（`5` / `-12`），看不出是六情的哪一块。改成 `怒+5`、`悲-3`、`无聊-12` 这样**块名 + 带符号数值**；思念/无聊同样处理。

**口径**（用户逐项确认）：

- **只改面板显示层**：日志 `.md` 的「变化」列照旧写纯数值（`+5` / `-12`），回滚解析 delta 的口径不动，历史行与新行在面板里看起来一致。
- **六情/思念/无聊真实变化行** → `块名+带符号数值`（`怒+5`、`悲-3`、`悲+8.7`、`怒+0.5`（传播子行）、`思念+6.3`、`无聊-12`）。
- **状态触发行**（delta 恒 0，不代表数值变化）→ `—`。
- **回滚替换行** → `回滚+0`（改值回滚按新值显示，如 `回滚-2`），让人一眼看出那是账面替换而不是真的又变了 0。

**实现**：`lib/log.js` 新增 `MoodLog.changeText(entry)`（纯函数，块名取自行所在的 `## 块`，正数补 `+`）；`lib/routes.js` 的 `/dsh-mood-changes/log` 给每条 entry 加 `change` 字段（不改 `delta`，回滚/工具口径不变）；`client.js` 变化列优先显示 `e.change`，老响应没有该字段时退回旧数值显示。落盘与解析链路零改动。

**回归**：新增 `_tmp/mood-smoke/change-text-test.mjs` 28 项（纯函数 12 + 真文件读写 5 + 落盘仍是纯数值 2 + 回滚链路 3 + 路由响应 6），全绿；其余 11 个无 vLLM 脚本照跑全绿。

---

## 2026-11-24 下午：E10 注入消息缺 id，把世界归档卡死（现场查清）

**症状**：世界控制台健康提示一直挂着——

```
会话 session-175c9f96-… 归档未完成：
stored session "session-175c9f96-…" failed validation:
Error: session event at seq 5048 lacks an identified message
```

**查法**：会话日志是 `sessions\<工作区>\<id>\session.v4.jsonl.zstd`，用 `zstd.exe -d` 解压逐行看。seq 5048 与 5135 两条都是 `user/message`，`data` 里**没有 `id`**，`source.kind` 都是 `plugin:dsh-mood-changes`——就是情绪插件敲门（「无聊 65.4，要不要自己做点什么？」）那两条。全份 5335 行里只有这两条缺 id。

**根因**：`lib/statusbar.js` 的 `_post()` 调 `agent.inject({ role:'user', content, source })`，没给 `id`。host 的存储校验要求每条 surface 消息带 message id（`UserMessage extends MessageBase`，`id: MessageId` 必填），对不上就整份拒绝打开。世界的重放是整份重放，一拒绝就从头卡在那一行，**后面的对话既不进记忆索引，也不进 `conversations/`**（11-24 09:40 之后到收工那段因此没归档）。

**修复**（0.2.14）：`_post()` 里补 `id: randomUUID()`（`node:crypto`），状态条和敲门两条注入路径共用。备份 `lib/statusbar.js.bak-20261124-id`。`source.kind`、正文格式、自注入跳过（B2）全部不变。

**回归**：新增 `_tmp/mood-smoke/statusbar-id-test.mjs` 13 项（id 存在/UUID v4 形状/role/source/正文一致/敲门/53 次不重复/无 inject 容错）。

**还欠一步**：历史那两条（5048、5135）仍缺 id，所以那份旧会话归档还卡着。补它要改 host 的会话文件（解压 → 补字段 → 压回），属于工作区外的核心数据；2026-11-24 用户决定**先不修**，等以后再说。

---

## 2026-11-24 下午：E11 GET /tick 调试核算接口

**背景**：核算 15 分钟一次，调试时只能干等下一跳才知道 tick 有没有抛错（或者想立刻看到队列结算后的数）。0.2.14 加一条只读调试路由：

```
GET /dsh-mood-changes/tick
→ { ok: true, lastTickAt, values, queue }        // 成功：立刻跑一次 tick
→ { ok: false, error: "<stack>" }                // tick 抛错：把堆栈带回来
```

**实现**：`registerRoutes()` 多收一个可选 `onTick`；不传时**不注册**该路由（旧装配/测试照样能跑）。`index.js` 把 `tick(now)` 传进去。用 GET 是因为 resource 路由只接 GET/HEAD，本机只读调试够用；**它会真的改账**（结算队列、落盘），不是纯查询。

**回归**：新增 `_tmp/mood-smoke/tick-route-test.mjs` 13 项（三条路由都注册/disposer、成功回显、onTick 恰好一次、错误回 ok:false+堆栈、不传 onTick 不注册且 state/log 照旧、/state 字段回归）。

---

## 2026-11-24 下午：E12 主动核算 mood_settle（用户需求）

**需求**：判句入账平时要等 tick（15 分钟一跳，或强触发才立即结算）。模型想马上把「上次结算到现在」积的账算完、或者想撤一笔还没结算的判句，没有手段（未结算的条目没有日志行，`mood_rollback`/`mark` 都会报「找不到可回滚行」）。要一个**由模型主动启动、无冷却、只计算不衰减**的核算入口。

**口径**（用户逐项确认）：

- 结算范围 = **上次结算到现在**积在 `state.queue` 里的所有判句事件；**包括这段时间里被决定要回滚的条目**——先照常入账、写日志，想撤就核算完再用 `mood_rollback`（或先 mark、核算后 executeMarked）。核算不会跳过任何排队事件。
- **真入账**：应用 delta + 耦合传播 + 写主条/传播行日志 + 立即落盘。
- **只结算**：不做时间衰减、不推进 `lastTickAt`、不跑思念/无聊、不掷骰、不注入。和 tick 的区别是只做中间那一步。
- **无冷却**，可连调；**队列为空** → `success:true, settled:0`，提示没有待结算事件，不报错。

**实现**：

- `index.js`：`settleEntries()` 改为返回本次写出的 `logBatch`（空队列返回 `[]`）；新增 `settleQueueNow(now)`——记录 before、drain 队列、结算、收集 changes/values，返回 `{queued, rows, changes, values}`。
- `lib/tools.js`：`registerTools()` 多收可选 `settleNow`，注册 `mood_settle`（零参数；不传 `settleNow` 时不注册，向后兼容旧装配）。返回 `{success, settled, rows, changes, values}`；结算后 `saveNow()` 落盘。
- 工具描述写明「先核算、再回滚」的正确顺序，以及不改 tick/不衰减的边界。

**回归**：新增 `_tmp/mood-smoke/settle-test.mjs` 30 项——入队不结算（数值/日志不动）、调用后真入账（+15、传播行、日志）、**不衰减**（surprise 40 不动；sad 只被传播 -0.75）、lastTickAt/思念/无聊不动、队列清空并落盘、空队列 settled:0、**核算后回滚找得到日志行**、无冷却连调、不传 settleNow 不注册。

---

## 2026-11-24 下午：E13 状态条/敲门只发她的会话

**症状**：15:32 那跳 tick 之后，工作会话（另一个 live agent）也收到了一条 `【情绪】乐（乐 53.2 / 悲 35.5）｜状态：焦虑`。注入代码遍历 `agents.list()` 全量发，设计前提「一个她」被多开的工作会话打破了。

**修复**（0.2.16）：`@deepseek-ai/dsh-agent` 的 `Agent.id` 就是 `SessionId`，所以按 `config.targetSessionId` 过滤即可：

- `index.js` 新增 `isHerAgent(agent)`：`!targetSessionId || agent.id === targetSessionId`。
- **状态条注入**（tick 第 9 步）和 **敲门**（`knock()`）两个循环都加过滤；未配 `targetSessionId` 时保持旧行为（所有 live agent 都发）。
- `statusBars` 仍按 agent 注册（配置热更时不用重建），只在发送时过滤。

**回归**：新增 `_tmp/mood-smoke/inject-scope-test.mjs` 9 项——两个 mock agent（她 + 工作会话），状态条只发她、敲门只发她、工作会话零注入、注入仍带 id/source、tick 正常推进、未配 `targetSessionId` 时两个都发（旧行为保留）。

---

## 2026-11-24 下午：E14 按工作目录自动认家（用户需求）

**需求**：换会话后 `targetSessionId` 就过时了，每次都得等 set-home 改配置。改成「按特定工作目录找未归档会话」：**投送、判句来源、降值都认同一个会话**，换会话自动跟上。

**DSH 侧的事实**（读代码确认，不是猜的）：

- `Agent.id` 就是 `SessionId`（`@deepseek-ai/dsh-agent` 的 Agent 接口）。
- 活的会话从 `ctx.sessions.list()` 拿，`session.header` 有 `cwd`（创建时的工作目录，canonical）和 `createdAt`。
- DSH 工作区的归档集合在 `ctx.workspaceRegistry.archivedSessionIds`（getter，`dsh-workspace`），用来精确排除「已归档」。

**语义**（用户拍板）：

- 新配置 **`targetWorkspaceDir`**（如 `F:\DSH\.dsh\worlds\lian\room`）优先级高于 `targetSessionId`；没配目录时才退回按会话 id；两个都没配 = 所有会话（旧行为）。
- 目标 = 该目录下**最新创建、未归档、活着的根会话**：
  - 排除其它目录（工作会话）；
  - 排除 `workspaceRegistry.archivedSessionIds` 里的（即使它还活着）；
  - 排除 `origin: 'subagent'` 和带 `parentSession` 的（家是根会话，不投给 subagent/fork）；
  - 多个候选取 `createdAt` 最大的一个。
- **每次需要时重新解析**，不缓存：换会话后下一条消息/下一跳 tick 自动跟上；目录下没有活着的家 → 谁也不投，**不回退成全量**。
- `session/event` 过滤、状态条注入、`knock()`、`tools/result` 的会话归属都用同一个解析结果。
- 顺带修正：状态条/敲门**实际投出去至少一条**才更新 `lastInjectAt` / 重置摘要段；没有接收者时不吞掉节奏。

**配置**：profile `cordis.patch.yml` 的 mood 段加了 `targetWorkspaceDir: 'F:\DSH\.dsh\worlds\lian\room'`（备份 `cordis.patch.yml.bak-20261124-workspacehome`；文件原来带 UTF-8 BOM，这次按 node 脚本写回时剥掉，YAML 解析已验证）。`targetSessionId` 留着当兜底。

**回归**：新增 `_tmp/mood-smoke/workspace-home-test.mjs` 12 项——多候选里选中最新未归档根会话、已归档（即使活着）/工作目录/subagent/fork 都不投、状态条与敲门只发它、工作会话消息不入账、换会话后自动跟上（新会话被认、旧会话不再入账）、目录下没有家时谁也不投。

---

## 2026-11-24 晚：E18 面板显示「上次掷骰」（用户需求）

**需求**：点开胶囊后加一行，像「思念：未掷中 · 524分钟前　　无聊：未掷中 · 218分钟前」；**夜里停掷的时候写「夜晚停掷」**。

**数据从哪来**：判官只管六情，思念/无聊的「敲门」是插件自己的掷骰（`Missing.shouldKnock` / `Boredom.shouldKnock`，45 分钟一次、夜里不掷、≥80 直接命中）。原来 `shouldKnock` 只记 `lastRoll`（时间），**没记掷中没有**，面板拼不出这句话。

**改法**：

- `lib/missing.js` / `lib/boredom.js`：`shouldKnock` 里补 `lastRollHit = hit`（含 ≥80 直接命中那条分支）。掷骰概率、阈值、45 分钟 CD、夜间窗口一律不动。
- `lib/store.js` / `index.js`：新旧 state 都补 `lastRollHit: false` 兜底（老文件没有这个字段）。
- `lib/routes.js`：`/state` 的 `missing` / `boredom` 各加 `lastRoll` + `lastRollHit`；顶层加 `rollNightPaused`（导出 `isNightPaused(now)`，边界 23:00 起、07:00 止）。
- `client.js`：两条 bar 下面加一行小字——`思念：掷中/未掷中 · N分钟前　　无聊：…`；从没掷过写「未掷过」；`rollNightPaused` 为真时两个都写「夜晚停掷」。

**回归**：新增 `_tmp/mood-smoke/roll-status-test.mjs` 37 项——值不够/夜间不掷不动字段、45 分钟 CD、≥80 直接命中、随机未中（false 但 `lastRoll` 照样推进）、随机命中、思念/无聊两条链一致、夜晚停掷边界（22:59/23:00/06:59/07:00/15:00）、`/state` 透出三个字段、旧 state 兜底 0/false。

---

## 2026-11-24 晚：E19 设置页（插件配置 + 运行参数 + 情绪基线）

**需求**：设置界面要能看见并手改插件配置；客户端不再自动生成插件配置页，要插件自己往 `settings.plugins.tab` 注册 tab。随后追加：**思念/无聊的增速、衰减 CD、情绪基线也要能在那个界面改**，并且**分块**（增速一块、CD 一块）。

**DSH 侧事实**（读源码/实机确认）：

- 客户端 Service 目录里没有 `settingsScope` / `webUiSettings`（44.x），设置页只能自己开本机 HTTP 接口（QQ 桥也是这个路子）。
- `settings.plugins.tab` 是 list slot：注册 `{ id, order, label }`，owner 按顺序渲染 tab；再用 `slots.register(..., Component)` 挂内容。
- 插件配置的读写走宿主 Service `configEditor`：`ctx.get('configEditor')` + `ctx.fiber.entry` + `editor.edit(entry, current => next)`；普通字段改完会**重启插件**，所以 POST 先回响应再异步写。

**改法**：

- `lib/config-api.js`：三条本机接口（只收回环地址、POST 要 `application/json`、白名单键）——
  - `GET/POST /dsh-mood-changes/config`：profile 的 `cordis.patch.yml`（11 个字段，写走 `configEditor.edit`，响应 `restarting:true`）。
  - `GET/POST /dsh-mood-changes/tuning`：运行参数，存 `worldDir/mood/tuning.json`，**即时生效不重启**。
  - `GET/POST /dsh-mood-changes/baseline`：六情基线，写 `mood/baseline.json`，基线 watcher 自动同步（低于新基线的当前值被补齐）。
- `lib/tuning.js`（新）：默认值 = 旧常量；`normalizeTuning` 丢脏值/校验范围；`toDisplay/fromDisplay` 做毫秒↔分钟；`isNightHour` 支持自定义夜间窗口。
- `lib/missing.js` / `lib/boredom.js`：`tick/drop/onToolCall/shouldKnock` 加可选 `opts`（不传 = 旧行为），把写死的 0.5 / 4.5 / 3600000 / 1800000 / 0.8 / 0.7 / 0.6 / 工具窗口 / 第 5 次 / 23–7 点全部参数化。
- `index.js`：启动时 `loadTuning`，所有调用点传 `tuning`；设置页保存后通过 `setTuning` 更新内存。
- `client.js`：注册 `settings.plugins.tab`（id `dsh-mood-changes`、order 90、label「情绪插件」），设置页三块——**插件配置**（11 项，保存后重载）、**运行参数**（按 增速 / 衰减 / 冷却 / 夜间 分块，共 13 项，保存即生效）、**情绪基线**（六情 6 个数字）。

**回归**：新增 `_tmp/mood-smoke/tuning-test.mjs` 50 项——默认值/脏值丢弃/范围校验、毫秒↔分钟往返、夜间窗口（默认与自定义跨零点）、参数化后的增速/系数/冷却/工具窗口/追加次数、`loadTuning`/`saveTuning` 落盘、`/tuning` 与 `/baseline` 的 GET/POST 与 400/403；全量 20 个脚本 368 项断言全绿。

---

## 2026-11-24 晚：E20 设置页兜底注册独立 section（用户给配方后）

**背景**：用户递来《DSH插件设置页改造配方》（`C:\Users\fan\Desktop\DSH插件设置页改造配方.md`）。配方实测：DSH 44.7.0 里 `settings.plugins.tab` 只是「插件」section 里的页签，**「插件」这一项是否显示由 DSH 决定**；只注册 tab 的话，section 不显示就等于整页看不见。QQ 桥的做法是**再注册一个独立 `settings.section`**（左侧一整页），跟「世界控制台」「皮肤」一样。

**核对**：查了当前 slot 树——`settings.section` 的 occupants 有 account / general / models / plugins / agent-presets / world-console / qq-bridge / skin-center，`plugins` 在（order 15），qq-bridge 已单独注册（order 30）。

**改法**（`client.js`）：

- 同时注册两处，同一组件 `MoodSettingsTab`：
  - `settings.section`：id `dsh-mood-changes`、order 29（世界控制台 28 之后、QQ 桥 30 之前，左侧显示「情绪插件」）。
  - `settings.plugins.tab`：id `dsh-mood-changes`、order 90（原样保留）。
- 注册包在 `ctx.inject(['slots'])` + `setTimeout(0)` 里（配方要求：等 slots 就绪再注册，旧版让原生服务先注册），单个 slot 不存在时 `try/catch` 兜住，不影响 apply。

**验证**：重启后查 `settings.section` 的 occupants 应出现 `{ registrant: 'dsh-mood-changes', id: 'dsh-mood-changes', order: 29, active: true }`；左侧导航应出现「情绪插件」。未新增断言（客户端 slot 注册无法在 host 测试里跑；全量 20 脚本 368 项仍绿）。

---

## 2026-11-24 晚：E21 设置页改卡片墙（用户需求，照世界控制台）

**需求**：用户给世界控制台的截图（「此刻 / 家 / 健康 / 记忆」卡片墙），要求设置页「改成这样，每一类有一块，点进去，单独改」。

**改法**（只动 `client.js`，接口不变）：

- 设置页从「一张长表单」改成两级：
  - **首页**：2 列卡片墙，六张卡——插件配置 / 增速 / 衰减 / 冷却 / 夜间 / 情绪基线；卡上虚线标题 + 现状摘要（如「思念 0.5 /跳，无聊 4.5 /跳」）。
  - **详情页**：点卡片进入，`← 返回` + 该类字段 + 一个「保存」按钮；只提交本组字段。
- 保存按类分发：`config` → `/config`（整组，插件重载）；四个 tuning 组 → `/tuning`（只发本组 path，即时生效）；`baseline` → `/baseline`（六情）。
- 样式沿用卡片风格（`--dsw-alias-*` token、圆角、虚线分隔、`pre-line` 摘要换行）。

**验证**：`node --check` 通过；全量 20 个脚本 368 项断言仍绿（接口与保存逻辑未动）。重启 DSH 后打开设置 →「情绪插件」即为卡片墙。

---

## 2026-11-24 晚：E22 横向页签 + 配色 + 六情半衰期（用户需求）

**需求**：① 照世界控制台，页签要**横着排**（概览/人设/世界提示词…那样），一类一块；② 加点颜色，别太单调；③ 衰减里把**六情单次衰减的系数**也加进去。

**改法**：

- `client.js`：
  - 去掉卡片墙，改成顶部一排横向页签（`插件配置 / 增速 / 衰减 / 冷却 / 夜间 / 情绪基线`），当前页签用主题色下划线 + 加粗。
  - 每类一个主题色：配置灰蓝 `#94a3b8`、增速绿 `#34d399`、衰减橙 `#fb923c`、冷却蓝 `#60a5fa`、夜间紫 `#a78bfa`、基线粉 `#f472b6`；内容区左侧 3px 彩条、输入框边框/光标、保存按钮都用该色。
- `lib/tuning.js`：新增 `mood` 组，六个半衰期（毫秒）：乐 5h / 悲 10h / 怒 6h / 惧 12h / 惊 2.5h / 厌 30h（默认 = `lib/pool.js` 旧常量）；字段单位 `hours`（小时，允许小数）。
- `lib/pool.js`：`MoodPool.decay(values, baseline, dtMs, skipBases, opts)` 读 `opts.mood[base+'HalfLifeMs']`，不传 = 旧默认。
- `lib/tools.js`：回滚重放的「扣剩余」也读 tuning 半衰期（`registerTools` 多收 `getTuning`），保证改过半衰期后回滚口径一致。
- `index.js`：tick 的 decay 传 `tuning`；`registerTools` 传 `() => tuning`。

**回归**：`tuning-test.mjs` 50 → 57 项（半衰期可调/显示小时/1.5h 往返/拒绝 0/decay 实测一个半衰期/改 10h 只衰减 √0.5/不传 opts 回落默认）；全量 20 个脚本 **375 项断言全绿**。

---

## 2026-11-24 晚：E23 衰减分章（用户需求，在另一边的显示改动之上）

**背景**：另一边先把设置页的显示层改了——字号 12→14、输入改成「左标签 / 右输入框」两列、主人昵称这类列表字段改用 textarea（一行一个）、页签改成「强调色描边 + 12% 淡底」的胶囊、基线六项两列。这些改动在本版一并提交（`client.js`）。

**需求**：衰减块里的字段混在一起，要「像文章的章节分章一样」，**六情一块、思念/无聊一块**。

**改法**（只动 `client.js`）：

- 加 `TUNING_SUBGROUPS`：按字段 path 前缀划分——`mood.*` → 「六情衰减」，`missing.*` / `boredom.*` → 「思念与无聊」。
- `fieldsFor` 支持子章节：每个章节一个 `— 标题` 小标题 + 虚线分隔（延续世界控制台卡片标题的风格），字段按原顺序过滤进各自章节。
- 保存逻辑不变：`saveTuningGroup('衰减')` 仍一次提交整块（两章一起保存）。

**回归**：只改排版，接口/保存/断言都没动；全量 20 个脚本 **375 项断言仍绿**，`node --check` 通过。

---

## 2026-11-24 晚：E24 主人判定（用户需求：桌面默认主人 / QQ 认主人）

**需求**：QQ 端要「认主人」（按昵称），桌面端输入框来的消息**默认就是主人**。

**原实现的问题**：`ownerFromSource` 对 `kind === 'user'` 之外的非插件 kind（`rpc`、客户端标记等）返回 `false`；QQ 桥的老格式 `kind: 'plugin'`（无冒号）也不走 QQ 解析。两处都可能让「主人说话」被漏认。

**改法**（`index.js`）：

- `ownerFromSource(kind, text, names)` 提到模块顶层并导出（便于测试）：
  - `kind` 不是插件注入（`!` / `user` / `rpc` / 其它）→ **主人**（桌面端输入框、系统消息都算）。
  - 插件注入（`plugin` 或 `plugin:<包名>`）→ 只解析 QQ 消息：`[QQ · 私聊] 昵称：内容` 且昵称在 `ownerNames` 里 → 主人；群聊 / 别人 / 摘要 / 非 QQ 插件消息 → 不算。
- `onUserMessage` 调 `ownerFromSource(kind, text, ownerNames)`（显式传昵称表）。

**回归**：新增 `_tmp/mood-smoke/owner-test.mjs` 13 项——桌面端 user/空/undefined/其它 kind 都是主人；QQ 私聊主人在名单→主人、别人→否、名单空→否、昵称带空格→认；QQ 群聊→否；legacy `plugin` 同样规则；非 QQ 插件消息与 QQ 未唤醒摘要→否。全量 **21 个脚本 388 项断言全绿**。

---

## 2026-11-25 上午：E26 判官判定记录 + 入账门槛 0.10（用户需求，另一边实现）

**需求**：判官判了「没变化 / 强度没过门槛 / 调用失败」时，情绪日志一个字都不留，事后只能翻 vLLM 日志猜；另外把入账门槛 0.15 → 0.10。

**改法**：`lib/judge-log.js`（新文件）+ `index.js` 三处 `fireAndForget(judgeLog.append(...))`——判官每次调用落一行到 `worldDir/mood/judge-log/YYYY-MM-DD.jsonl`，记录 `at / ok / clear / confidence / about / emotions / applied / states / skipped / verdict / round`（round 截 400 字）。门槛同步改：`judge.js` 的 `_validate` 与 `_lexiconFallback`、`index.js` 的 `score < 0.15*cap`、`data/judge-prompt.md` 的「小于 0.15 不要输出」、`lexicon.json` 的注释全部 0.10。

**回归**：`qq-judge-input-test` 覆盖不了它；现有 22 个脚本全绿。

---

## 2026-11-25 上午：E27 判句输入按来源改写 + 时间排序 + 状态条只在她场时注入（用户需求）

**用户原话要点**：① 判官不该看到 `[QQ · 私聊]` 与「（回 QQ 用…）」；主人 QQ →「用户：内容」，别人 →「昵称：内容」；② 这一轮里 QQ 侧触发的执行请求、`qq_bridge_send` 发出去的话、注入、最终回复，按时间顺序送判官；③ 生活线提醒和 QQ 消息要能区分开；④ 早上连续三次「收到执行请求」（【情绪】乐惧 48.9/45.4/42.4）查明并修。

**#1 的根因（已查明）**：状态条按 60 分钟 CD 往 `agent.inject()` 里塞，跟她醒没醒无关。她夜里不在场，注入就排在 inbox 里；08:50 生活线叫她时，Inbox 被 splice，三条状态条一起进来（seq 3692/3693/3694 同一时刻 08:50:00），每条都是**它自己生成那一刻**的旧数值（三条相隔约 1 小时，正好差一小时衰减量）。修法：`tick` 第 9 步加「她 30 分钟内有过消息」才注入；`init` 把 `lastActivityAt` 设成启动时刻（否则刚启动时 0 会当成一直未活动/或一直活动）。

**#3/#5/#6 的改法**：`judgeLineFor(kind, text, isOwner)`（导出）——QQ 桥拆 `[QQ · …]` 前缀与「（回 QQ 用…）」行，**私聊且昵称在 `ownerNames` 里 → `用户：内容`**，别人 → `昵称：内容`（群聊同样，群名不进判句）；`dsh-world-life` → `【生活线】…`；`runtime-context`/`time-context` 直接不进判句；桌面端 → `用户：…`。

**#4 的改法**：`buildRoundLines(events, reply)` 接这一轮的全部事件（`{ts, kind, line}`），按 `ts` 排序，`qq_bridge_send` 的话以「她（QQ 发出）：…」插在它发生的位置，回复固定最后；同一句已经出现在回复里就不重复。

**回归**：`qq-judge-input-test` 21 → 22 项（新 API + 时间序 + 来源标注）；`index-flow-test` 19 项；全量 22 个脚本 411 项断言全绿。

---

## 2026-11-25 凌晨：E25 QQ 桥的消息读给判官（用户需求：只读，不拦截）

**需求**：若这一轮调用了 `qq_bridge_send`，或者有 `plugin:dsh-qq-bridge` 的注入，**把里面的消息内容读给判官**。

**原来的缺口**：

- `qq_bridge_send` 是**工具调用**，不进 `assistant/message`。只在工具里说的一轮（QQ 回复走工具通道时），判官看到的这一轮只有「用户：…」、没有「她：…」——她说了什么、说得什么语气，判官完全不知道。
- `plugin:dsh-qq-bridge` 注入的入站消息虽然会走 `user/message`，但带着桥自己贴给模型的指令行，判句没法确认「读到的确实是 QQ 那边说的话」。

**改法**（只动 `index.js`，QQ 桥的收发链路一行没碰）：

- `tools/result` 里顺手读 `exec.arguments.text`：工具名 `qq_bridge_send` 才取，参数是对象或 JSON 串都认；按会话攒在 `qqSends` 里（一轮最多 5 条）。
- `turn/end` 拼判句行时：`buildRoundLines(users, reply, sends)` → 「用户：…」+「她：…」+「她（QQ 发出）：…」；同一句已经出现在她的回复里就不重复喂。**只在工具里说话的一轮也触发判句**（以前 `!reply` 直接 return）。
- `plugin:dsh-qq-bridge` 注入的正文经 `judgeTextFor(kind, text)` 原样读进判句（非 QQ 来源一个字不动）。
- **内容不改写**：没有过滤、没有替换、没有改写标点；唯一处理是 2000 字长度上限——判官后端上下文很小，超长一段会让 LLM 直接失败、退回词表，等于白判。
- 三个纯函数导出（`judgeTextFor` / `qqSendTextOf` / `buildRoundLines`）供测试直接跑。

**回归**：新增 `_tmp/mood-smoke/qq-judge-input-test.mjs` 21 项——QQ 注入原样读（含指令行）、群消息原样、桌面端不动、非字符串容错、2000 字上限与短消息不变、`qq_bridge_send` 参数对象/JSON 串/坏 JSON/无 text/空白裁剪、拼行三件套、重复句不喂两遍、纯工具轮、旧状态回退、全空无行；`index-flow-test` 加 1 项（无 assistant/message、话全在工具里也照样判句）。全量 **22 个脚本 410 项断言**。

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
- **E1** `index.js settleEntries()`：传播只取每笔 entry 中实际落账值最大的 base、以实际落账值为源；副情绪不再传播、不再回传主情绪。
- **E2** `lib/tools.js mood_rollback`：block=状态 时走独立分支——账面划线 + 状态清除/时效回退；`lib/log.js` 替换行级联注记改条件式。
- **E3** `lib/tools.js mood_rollback`：数值回滚路径加级联——纯删除且判句主条全划线时连带撤触发行与状态；状态修正共用 `settleStateAfterRollback()`。
- **E4** `lib/boredom.js onToolCall()` + `index.js tools/result`：工具侧 1 小时滚动窗口，第 1 次 ×0.6（照旧冷却）、第 5 次追加 ×0.6（跳冷却），每窗口最多两次；state 加 `toolWindowStart/Count`（init 回填）。
- **E5** `client.js` 胶囊槽位 order 20→25：与 breezetts 语音条（order 20）错开，平局时加载顺序决定排位、重启即换位的问题根除。同场清理：profile node_modules 的断链 `mood-diag` junction 与旧命名残留 `dsh-mood` junction（都只是别名链接，非注册实体）已删。
- **E6** `lib/log.js rollback()` pass 1 跳过情绪列为「回滚」的替换行**和「传播」子行**：两者都与同分钟写入的判句主行共享时间列，回滚曾误把替换行当目标划掉（2026-11-23 22:52 现场：她想撤 22:50 的判句，工具先划掉了 22:50 的替换行，第二次调用才碰到主条）；传播行同理可能排在主条前面（23:03 悲块）。两者从此永不作为直接回滚目标——子条跟着源头级联撤；找不到可回滚行时失败原因注明「回滚替换行/传播子条不算目标」。
- **E7** `lib/tools.js mood_rollback` 三种直接模式：单笔（time+block，支持 newDelta）/ **范围清扫**（from+to，把范围内所有站着的六块判句主条全部纯删除，每笔带传播级联 + E3 状态级联；思念/无聊/状态行与范围外不动；每轮循环取最新快照的第一条站立马条，同分钟兄弟行下一轮再取，失败的目标记入 failed 集合保证终止）/ **列表批量**（items=[{time,block}…]）。**0.2.11 标记机制（用户拍板）**：`mark` 把误判条目标为待回滚（存 `state.pendingRollback`，持久化；只标记不动数值不动日志）；`executeMarked: true` 一键执行全部已标记（走 rollbackOne，纯删除；标记后已被单独回滚的视为完成并移出队列）；`unmark` 解除；**无参数调用返回当前标记清单**。核心逻辑抽成 `rollbackOne`（不落盘，由调用方统一存一次）；批量/标记共用 note、只做纯删除。
- **E8** `lib/boredom.js onToolCall()`：第二次衰减（窗口第 5 次）改为**只跳同类型 1h CD、尊重跨类型 30min 互斥**——E4 实现时误把「跳过冷却」做成了跳过全部，现场（2026-11-24 08:12 消息 ×0.7 → 08:19 第 5 次追加 ×0.6 连打两窗口）实锤。被消息压住时计数保持 ≥5（不重置不丢），CD 过后的下一次工具调用补发该衰减；首笔衰减的互斥行为不变。
- **E9** `lib/log.js changeText()` + `lib/routes.js /log` 响应 `change` 字段 + `client.js` 变化列：块名+带符号数值（`怒+5`/`无聊-12`），状态行 `—`，回滚行 `回滚+0`；日志文件与回滚解析仍用纯数值，`delta` 字段保留。
- **E10** `lib/statusbar.js _post()`：补 `id: randomUUID()`——注入的 `user/message` 缺 id 会过不了 host 存储校验，让世界归档整份拒绝打开、卡在那一行（2026-11-24 现场：seq 5048/5135 两条敲门消息）。
- **E11** `lib/routes.js` 新增 `GET /dsh-mood-changes/tick`（可选 `onTick`，不传不注册）+ `index.js` 传入 `tick`：调试时立刻核算一次；返回 `{ok, lastTickAt, values, queue}`，出错回 `{ok:false, error}`。
- **E12** `index.js settleQueueNow()` + `lib/tools.js mood_settle`：模型主动核算——只结算队列（delta + 传播 + 写日志 + 落盘），不衰减/不推进 tick/不跑思念无聊/不掷骰/不注入；无冷却，空队列 `settled:0`。`settleEntries()` 返回 logBatch 供工具回显。
- **E13** `index.js isHerAgent()` + knock/状态条两个注入循环：状态条与敲门只发给 `targetSessionId` 对应的 agent（`Agent.id` 即 SessionId）；未配时全量旧行为。工作会话不再收到她的情绪。
- **E14** `index.js` 目标会话解析：`targetWorkspaceDir` 优先——`resolveWorkspaceHome()` 在 `ctx.sessions.list()` 里选该目录下最新创建、不在 `workspaceRegistry.archivedSessionIds`、非 subagent/fork 的根会话；`session/event`、状态条注入、`knock()`、`tools/result` 共用 `targetSessionId()` 解析（每次重新算，不缓存）；没配目录时退回 `targetSessionId`。投送成功才推进 `lastInjectAt`/摘要。
- **E15** `data/emotions.json`：`shy.label`「害臊」→「害羞」——状态名本来就叫「害羞」，同一个情绪两个名字，日志行（`害羞 shy`）、状态触发行（`触发：害羞`）、注入摘要（`单笔较大：害羞 +7`）三处显示统一。标签只经 `labelFor()` 用于显示，没有逻辑分支读它。改前查重：41 条细名里没有别的「害羞」，语义最近的是 `ashamed`「羞耻」（道德性羞愧，cap 25）与 `awkward`「尴尬」（当场窘迫，带 30min 状态），都不等义，保留；`nervous`「紧张」、`guilty`「愧疚」也不同向。改完「害羞」同时是标签和状态名，与 `soft`「心软」、`guilty`「愧疚」、`awkward`「尴尬」的既有写法一致。
- **E16** `data/emotions.json` 的 `shy.weights`：`fear 0.8 / happy 0.2` → **`fear 0.4 / happy 0.6`**（用户 2026-11-24 下午拍板「对亲近的人改成乐 0.6，惧 0.4」）。`closeOnly: ["happy"]` 不变，于是两个分支：亲近（`about='her'`）乐 0.6 / 惧 0.4；非亲近乐归零、惧重新归一 1.0——**非亲近落账与改前完全一致**。cap 17.5、状态「害羞」30min 乐×1.2 不动。例：intensity 0.6（score 10.5）→ 亲近 惧 +4.2 / 乐 +6.3（「害羞」状态激活时乐 +7.6）；非亲近 惧 +10.5。
- **E17** `lib/routes.js /log` + `client.js`：原先面板拿 `read()` 的文件顺序再整体 `reverse()`——文件是按块分组、块内按生效时间升序，反转后成了「块倒序 + 块内时间倒序」，最新那笔可能埋在中间。现在响应直接按**记录时间**降序（`localeCompare` 降序，`Array#sort` 稳定，同一分钟的主条/传播子行/状态行保持文件里的先后），client 去掉旧反转、原样吃；块筛选后也一样降序。**日志 .md 的排序一个字节没动**（仍按块分组、块内按生效时间升序），回滚/解析口径不受影响。
- **E25** `index.js`（只读，不拦截）：① `tools/result` 里 `qqSendTextOf(exec)` 读 `qq_bridge_send` 的 `text` 参数（对象或 JSON 串，按会话攒 `qqSends`，一轮最多 5 条）；② `turn/end` 用 `buildRoundLines(users, reply, sends)` 拼行——用户行 + 她的回复 + 「她（QQ 发出）：…」，同一句已在她回复里则不重复，**纯工具轮也触发判句**；③ `judgeTextFor(kind, text)` 让 `plugin:dsh-qq-bridge` 注入的正文原样进判句（非 QQ 来源不动），只加 2000 字上限防炸判官上下文。QQ 桥的收发链路一行没碰；内容不改写、不过滤。

## 功能缺口收账

1. ~~判官两级~~ ✅（两级语义升级为「直接引发否/带前情综合判」）
2. ~~掷骰敲门接线~~ ✅（0.2.0 已接）
3. ~~alsoMissing / closeOnly / skipDecay~~ ✅（0.2.2 实现，features-test 22 项）
4. ~~摘要搭车~~ ✅（敲门时带）
5. ~~「护着」against~~ ✅（方案③：不认人，about=other 怒 ×1.1；against 字段保留数据不消费）
