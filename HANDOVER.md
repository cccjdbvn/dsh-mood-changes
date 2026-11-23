# dsh-mood 交接文档

> 交接日期：2026-11-23 晚 · **0.2.2**（代码完成、测试通过、**未安装**）
> 上一个会话把 SPEC v0.1 做完（v2.2.0），本会话按用户拍板完成**判官直判她**链路重构 + 三个小功能 + vLLM 常驻，版本序列重排为 0.x。
> 冲突时以本文档 > KNOWN-ISSUES.md > SPEC.md 为准（实现相对 SPEC 有多处偏差，见 §5；判官语义是本会话用户口述纠正的，以本文档为准）。

---

## 0. 一句话现状

情绪插件 0.2.2 **代码完成、全套测试通过（61 项）、已推 GitHub**；DSH 里实际跑的还是旧版 0.1.8（dsh-mood-changes，v1 链路）；本地判官（WSL2 + vLLM + Qwen2.5 3B AWQ）已**开机自启**（计划任务 mood-judge-vllm）。

---

## 1. 三个目录 + GitHub

| 位置 | 内容 | 用途 |
|---|---|---|
| `F:\DSH\work\plugins\dsh-mood` | **v2 开发目录（0.2.2）** | 日常改代码只改这里。node_modules 是指向 profile 的 junction（见 §7 坑 1） |
| `F:\DSH\work\plugins\dsh-mood-changes` | **v1 分支检出（0.1.8）** | profile 的 link 指向它——**DSH 里跑的旧版**。注意它也是 git 仓库本体 |
| `F:\DSH\work\plugins\dsh-mood-main` | **main 分支检出**（`git worktree`） | v2 进 git 的通道：改完 dsh-mood 后 robocopy 过来 commit（**必须排除 node_modules**） |

**v2 同步进 git 的流程**：改 `dsh-mood` → `robocopy F:\DSH\work\plugins\dsh-mood F:\DSH\work\plugins\dsh-mood-main /MIR /XD node_modules` → 在 dsh-mood-main 里 `git add -A && git commit` → push origin main。
（**别用 Copy-Item -Recurse**：node_modules 是 junction，会被展开复制。）

GitHub：https://github.com/cccjdbvn/dsh-mood-changes
- `main` = 0.2.2 ✅（本会话已推）
- `v1` = 0.1.8 ✅（本会话已推）
- **无欠账**，本地没有未推的 commit。

**千万注意**：`dsh-mood-changes` 目录当前在 v1 分支，别往里同步 v2 文件（会把 v1 弄脏）。v2 永远走 `dsh-mood-main`。

---

## 2. profile 关键信息

- profile 目录：`F:\DSH\.dsh\profiles\desktop`（`$env:DSH_PROFILE_DIR`）
- `package.json`：`dsh-mood-changes` 是 `link:F:/DSH/work/plugins/dsh-mood-changes`
- `cordis.patch.yml` 的 dsh-mood-changes 行：`worldId: lian`、`ownerNames: ['夏生']`
- 主人两个 QQ 号：`3538115602`、`2635714738`，**昵称都是「夏生」**（qq-bridge 的 ownerIds；QQ 桥转发消息只带昵称不带号，所以思念判定匹配昵称）
- qq-bridge 包在 profile node_modules，读它可参考正确写法（session/event 事件形状就抄它的，见 §4）

---

## 3. 本地判官（vLLM）——已开机自启 ✅

- WSL2 Ubuntu-22.04，GPU 直通正常（RTX 5060 Ti **16G**，Windows API 报 4G 是字段溢出，别信）
- venv：`/mnt/f/ai/envs/mood-judge-wsl`（Python 3.10，vLLM 0.31.0，全部在 F 盘）
- 模型：`F:\ai\model_mood-judge\Qwen2.5-3B-AWQ`（2.5G，**在用**）；`Qwen2.5-7B-AWQ`（5.2G，下好未测）
- Windows 侧 `http://127.0.0.1:8000/v1` 直达（WSL2 端口转发正常）

**常驻方案（本会话已装好）**：
- 守护脚本 `F:\ai\start-mood-judge.ps1`：查端口→查 WSL 内 vLLM 进程→防重复→前台挂 wsl（**必须前台，nohup 会被 WSL 回收**）→崩溃 60 秒重试。日志 `F:\ai\start-mood-judge.log`
- 入口 `F:\ai\start-mood-judge.vbs`（wscript 隐藏窗口；**内容必须纯 ASCII**，中文注释在无 BOM UTF-8 下会让 wscript 报 800A0400）
- 计划任务 `mood-judge-vllm`（ONLOGON 当前用户，ExecutionTimeLimit=0 不限时），已验证防重复触发正确
- 手动拉起（如果需要）：`schtasks /Run /TN "mood-judge-vllm"`
- **PowerShell 5.1 跑 .ps1 中文脚本必须带 UTF-8 BOM**（write 工具写的是无 BOM，脚本里 `([IO.File]::WriteAllText(..., [Text.UTF8Encoding]::new($true)))` 补过一次）

**判官真机实测**（新 prompt，判她）：「你根本不懂我」→她 hurt 0.7；「你今天怎么这么可爱」→她 **shy 0.6 + about=her**（closeOnly 生效）；操作请求→clear:false 无情绪；二级带前情判综合状态。延迟 1.6–4s（新 prompt 输入带对话，比旧单句慢），judgeTimeout 默认已调 6000ms。

---

## 4. 判官直判她（本会话核心重构，用户拍板）

**旧链路（SPEC v0.1）**：判官判"说话人（用户）"的情绪 → empathy.json 转换表 → 她的回应细名 → 入账。
**问题**：转换表值域只有 11 个细名，她的害羞/孤独/轻快等 14 个状态的宿主细名不可达，三标记无消费点。

**新链路（0.2.2）**：
1. **判官判的是她（智能体）**。41 个细名全是她的词表。`about` = 她这股情绪冲谁（her=冲用户/other=冲别人/thing=冲事情）。
2. **判句时机 = 她每次回复完**（`session/event` 的 `turn/end`）。她的输入源五花八门（直输、QQ 桥、读文件、别的插件注入），以"她开口"为采样点。她没开口的轮不判（用户消息留在窗口里给下轮二级用）。
3. **判官上下文独立**（不碰智能体上下文）：按轮存（用户行+她行），最多 5 轮；**CD 20 分钟**——任何消息刷新 CD，静默 20 分钟 tick 清空。
4. **两级判句**：第一级只给本轮对话，判"这轮对话是否**直接引起**她情绪变化"，不是→clear:false；第二级带前情判她**此刻**的综合情绪。第一级 confidence≥0.8 直接采信。
5. **入账**：判官输出细名 → emotions.json 的 weights/cap/state **直接消费**（empathy.js/empathy.json 已删除，新建 lib/emotions.js 做元数据访问）。
6. 挂点全部走 `ctx.on('session/event')`：`user/message`（B1 owner 判定/无聊降/思念降/收文本）、`assistant/message`（累积她的回复，**surfaceOp 是事件顶层字段**，replace 时重算——抄 qq-bridge 的教训）、`turn/end`（判句）。
7. B2 跳自己注入：`source.kind === 'plugin:dsh-mood'`。
8. 判官词表降级（LLM 失败/短词）**保留**，但词表语义还是旧的（按"他的情绪"标注），降级路径判她时有语义偏移，可接受、后续重审。

**三个小功能（本次实现，测试全过）**：
- `closeOnly`（shy）：她被判害羞且 about=her（亲近）→ happy 0.2 权重生效；否则归零重归一（fear=1.0）。`Emotions.adjustCloseOnly()`
- `alsoMissing`（lonely）：她被判孤独 → `Missing.lonelyBonus()` 按当前思念档加 2–4/4–8/8–12 + 日志行「孤独：她开始想主人」
- `skipDecay`（light）：她被判松快 → 轻快状态 → `States.consumeSkipDecay()` 每 tick 消耗一次，happy 冻结 2 跳衰减

**附带修复**：判句有实际入账/思念实际下降时**立即落盘**（原来走 3 分钟节流，崩溃会丢已写日志的账）。

---

## 5. 相对 SPEC 的实现偏差（用户拍过板的）

| SPEC 原文 | 实际实现 | 谁定的 |
|---|---|---|
| 判官判"说话人的情绪" | **判官判她（智能体）的情绪** | 用户（2026-11-23 纠正） |
| empathy 转换表 | **删除**，判官直判细名 | 用户 |
| 判句时机=每条用户消息 | **她每次回复完**（turn/end） | 用户 |
| 判官上下文=最近 10 条用户消息 | **独立上下文，含双方，5 轮，CD 20 分钟清空** | 用户 |
| 两级=置信度不足重判 | 第一级判"本轮直接引发否"，二级带前情判综合 | 用户 |
| about=他的情绪冲谁 | **她的情绪冲谁**（her=冲用户） | 用户 |
| 衰减按真实时间 | **B3 冻结**：dt 夹到一跳内 | 用户 |
| 判官第二轮 10 分钟窗 | 20 分钟 CD（见上） | 用户 |
| 摘要搭状态条 | 摘要只在**敲门**时带 | 用户 |
| 「护着」认人 | 方案③：不认人，护着期间 about=other 的怒 ×1.1 | 用户 |
| 日志五列 | **六列**：时间（记录）｜情绪｜变化｜原因｜状态｜生效。主条在结算时写 | 用户（A7） |
| 判官生命周期管理 | 没做（判官现在开机自启，插件只调用） | — |
| 短词缓存 | **取消** | 用户 |
| 版本 v1.x/v2.x | **0.1.x / 0.2.x**（v1.8.1→0.1.8，v2.2.0→0.2.2） | 用户 |

---

## 6. 剩余待办（按优先级）

1. **装 0.2.2**（等用户发话）。装法：profile link 从 dsh-mood-changes 换到 dsh-mood（`plugin_manager install_bundle F:\DSH\work\plugins\dsh-mood`，或改 package.json link + bundles 名换 dsh-mood）。注意 bundle 名 `dsh-mood`、patch id 也是 `dsh-mood`，worldDir/ownerNames 配置要迁。
2. **装后运行时验证**：
   - B1：QQ 桥转一条群消息 + 一条主人私聊，确认思念只对后者降（集成测试已过，真机再验）
   - B2：等一次注入，确认 `plugin:dsh-mood` 标记生效
   - **判句时机真机验证**：QQ 里聊一轮，看日志有没有 turn/end 触发的判句行（判官延迟 1.6-4s 正常）
   - 面板：药丸、卡片、日志页
   - 工具：mood_log/mood_rollback/mood_baseline
3. **词表语义重审**：lexicon.json 的 237 词按旧语义（他的情绪）标注，降级路径判她时有偏移（比如"对不起"→guilty，她不愧疚）。低优先（LLM 是主路）。
4. **session/event 的多会话口径**：当前所有 session 的消息都进判官窗口（跟旧 v2 statusBars 全 agent 口径一致）。若以后用 subagent/workflow 产生 durable session，可能污染判官上下文——装后观察。
5. 7B AWQ 未测（3B 够用可以先不动）。

---

## 7. 关键坑（下个会话别踩）

1. **node_modules 是 junction**：`dsh-mood\node_modules` → profile node_modules（为 schemastery）。**复制到 dsh-mood-main 必须 robocopy /XD node_modules**；别删它（删了测试跑不了）。
2. **state 存放路径是 `worldDir/mood/state.json`**（store.js 的 MOOD_DIR='mood'），不是 worldDir 根！测试曾经在这里栽过。日志在 `worldDir/room/情绪日志/YYYY-MM-DD.md`。
3. **Config 必须 `Schema.object`**（schemastery 3.18.5 在 profile node_modules）。普通对象导出会启动失败。
4. **data/*.json 带 UTF-8 BOM**——读取已容错，别新增裸 `JSON.parse(readFile(...))`。
5. **log.js 有内部串行链**（`_chain`）——写入一律走 `append`/`appendBatch`/`rollback`，别绕过。
6. **PowerShell 5.1 的 .ps1 带中文必须 UTF-8 BOM**；.vbs 必须**纯 ASCII**（wscript 按 ANSI 读）。
7. **session/event 信封**：`{type, seq, time, data, surfaceOp?}`；`user/message` 的 data 是 UserMessage（或包成 `{turn,step,message}`，两种都兜）；`assistant/message` 的 `data.message` 取文本；`surfaceOp` 是**顶层**字段，`'replace'` 时重算不累加。
8. **消息 source 形状**：DSH 输入框 `source.kind === 'user'`；QQ 桥 `source.kind === 'plugin:dsh-qq-bridge'`，文本格式 `[QQ · 群名/私聊] 昵称：内容`；本插件注入 `source.kind === 'plugin:dsh-mood'`。
9. **PowerShell 的 JSON/引号序列化很坑**——端到端测试一律写 node 脚本放 `_tmp`，import 用 `file:///F:/...` URL；别用 PowerShell 的 Get-Content/Set-Content 改带中文的文件（会写坏编码，本会话踩过）。
10. **agent.inject 的消息**：`{ role:'user', content:[{type:'text',text}], source:{kind:'plugin:...'} }`（照 qq-bridge）。
11. **文件全放 F 盘**（venv、模型、tmp、守护脚本）——用户明令不写 C/D（桌面清单除外，那是用户要看的）。
12. **WSL 常驻**：nohup 后台进程会被 wsl.exe 客户端断开回收，必须前台客户端挂着——守护脚本/DSH 后台 job 都是这个原理。

## 8. 测试命令

node 在 `F:\DSH\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`，都在 `_tmp\mood-smoke\`：

| 脚本 | 内容 | 依赖 |
|---|---|---|
| `run.mjs` | 9 项基础 smoke（时区/并发/转义/cap/传播） | 无 |
| `rollback-test.mjs` | A7 回滚链路 | 无 |
| `features-test.mjs` | 22 项三标记（closeOnly/alsoMissing/skipDecay） | 无 |
| `index-flow-test.mjs` | 16 项集成（session/event 全链路+判句+B1/B2+tick，判官走词表降级） | 无 vLLM 也能跑 |
| `judge-test.mjs` | 判官真机（判她情绪、两级） | **需 vLLM 在跑** |

语法：14 个 JS 文件 `node --check`。

## 9. 文件地图

```
F:\DSH\work\plugins\dsh-mood\        ← v2 开发目录（0.2.2）
├── SPEC.md           v0.1 设计稿（历史参考 + 0.2.2 变更说明）
├── KNOWN-ISSUES.md   审计清单（A/B/C 项修复状态）
├── HANDOVER.md       本文档
├── .gitignore        node_modules/
├── index.js          Host 入口（session/event 挂点、turn/end 判句、消费入账）
├── client.js         面板（dock 药丸 + shell.overlay 卡片）
├── lib\
│   ├── store.js      state/baseline 读写（mood/ 子目录、原子写+BOM容错）
│   ├── pool.js       六情池（半衰期；decay 支持 skipBases）
│   ├── judge.js      判官（判她、两级、串行链+围栏剥离+重试+词表降级）
│   ├── emotions.js   情绪表元数据访问（weights/cap/state/closeOnly/alsoMissing）
│   ├── log.js        六列日志（串行链+appendBatch+回滚账面）
│   ├── coupling.js   传播（乘 mods）+阻尼
│   ├── missing.js    思念（含 shouldKnock sigmoid、lonelyBonus）
│   ├── boredom.js    无聊（A/B 冷却+shouldKnock）
│   ├── states.js     17 状态（protectionFactor=护着③、consumeSkipDecay）
│   ├── statusbar.js  注入（source 标记+knock）
│   ├── routes.js     /api/mood/state + /api/mood/log
│   └── tools.js      三工具（mood_rollback 含数值重放）
├── data\             emotions/lexicon/judge-*/baseline/log-template（empathy.json 已删）
└── locale\ icon.svg docs\
```

桌面有用户看的精简清单：`C:\Users\fan\Desktop\dsh-mood 修复清单.md`（改完记得同步更新）。
