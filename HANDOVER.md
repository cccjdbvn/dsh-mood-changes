# dsh-mood 交接文档

> 交接日期：2026-11-23 下午 · v2.2.0（代码完成、**未安装**）
> 上一个会话把 SPEC.md（v0.1 设计稿）里能做的全做完了。本文档是给下一个会话的完整现场。
> 冲突时以本文档 > KNOWN-ISSUES.md > SPEC.md 为准（实现相对 SPEC 有几处偏差，见 §5）。

---

## 0. 一句话现状

情绪插件 v2.2.0 **代码完成、测试通过、已推 GitHub**；DSH 里实际跑的是旧版 v1.8.1（dsh-mood-changes）；本地判官（WSL2 + vLLM + Qwen2.5 3B AWQ）已就绪但属于临时进程。

---

## 1. 三个目录 + GitHub

| 位置 | 内容 | 用途 |
|---|---|---|
| `F:\DSH\work\plugins\dsh-mood` | **v2 开发目录** | 日常改代码只改这里 |
| `F:\DSH\work\plugins\dsh-mood-changes` | **v1 分支检出** | profile 的 node_modules link 指向它——**DSH 里跑的旧版**。注意它也是 git 仓库本体 |
| `F:\DSH\work\plugins\dsh-mood-main` | **main 分支检出**（`git worktree`） | v2 进 git 的通道：改完 dsh-mood 后 Copy-Item 过来 commit |

**v2 同步进 git 的流程**：改 `dsh-mood` → 复制到 `dsh-mood-main` → 在 dsh-mood-main 里 `git add -A && git commit` → push origin main。

GitHub：https://github.com/cccjdbvn/dsh-mood-changes
- `main` = v2.2.0（`cadb9b8`）✅ 已推
- `v1` = v1.8.1（`e6510aa`）✅ 已推
- **无欠账**，本地没有未推的 commit。

**千万注意**：`dsh-mood-changes` 目录当前在 v1 分支，别往里同步 v2 文件（会把 v1 弄脏）。v2 永远走 `dsh-mood-main`。

---

## 2. profile 关键信息

- profile 目录：`F:\DSH\.dsh\profiles\desktop`（`$env:DSH_PROFILE_DIR`）
- `package.json`：`dsh-mood-changes` 是 `link:F:/DSH/work/plugins/dsh-mood-changes`
- `cordis.patch.yml` 的 dsh-mood-changes 行：`worldId: lian`、`ownerNames: ['夏生']`
- 主人两个 QQ 号：`3538115602`、`2635714738`，**昵称都是「夏生」**（qq-bridge 的 ownerIds；QQ 桥转发消息只带昵称不带号，所以思念判定匹配昵称）
- qq-bridge 包在 profile node_modules，读它可参考正确写法（Config 用 Schema.object、消息 source 形状）

---

## 3. 本地判官（vLLM）——已就绪，临时进程

- WSL2 Ubuntu-22.04，GPU 直通正常（RTX 5060 Ti **16G**，Windows API 报 4G 是字段溢出，别信）
- venv：`/mnt/f/ai/envs/mood-judge-wsl`（Python 3.10，vLLM 0.31.0，全部在 F 盘）
- 模型：`F:\ai\model_mood-judge\Qwen2.5-3B-AWQ`（2.5G，**在用**）；`Qwen2.5-7B-AWQ`（5.2G，下好未测）
- Windows 侧 `http://127.0.0.1:8000/v1` 直达（WSL2 端口转发正常）

**启动命令（重启电脑后要用）**：
```
wsl -d Ubuntu-22.04
VLLM_USE_FLASHINFER_SAMPLER=0 /mnt/f/ai/envs/mood-judge-wsl/bin/python -m vllm.entrypoints.openai.api_server --model /mnt/f/ai/model_mood-judge/Qwen2.5-3B-AWQ --host 0.0.0.0 --port 8000
```
- **`VLLM_USE_FLASHINFER_SAMPLER=0` 必须带**：WSL 没装 CUDA toolkit（无 nvcc），flashinfer 的采样 JIT 编译会炸；关掉走原生 torch 采样
- 首次启动慢（torch.compile 几分钟），缓存落在 WSL home，二次启动快
- **WSL 常驻坑**：`nohup ... &` 的后台进程在 wsl.exe 客户端断开后会被实例回收——要常驻必须有个前台 wsl 客户端挂着（现在就是这么跑的，挂在 DSH 的后台 job 里）
- **常驻方案用户还没定**（一键脚本 / 开机自启 / 不管）——待问

**判官真机实测**（`F:\DSH\work\_tmp\mood-smoke\judge-test.mjs`）："你根本不懂我"→hurt 0.86 her；"气死我了"→angry 0.9 thing；稳态 300–700ms；≤5 字 0ms 走词表。

---

## 4. v2 已实现清单（相对 SPEC.md）

核心全部完成：六情池（半衰期向基线回归、cap、clamp）· 判官（LLM+237词降级、≤5字跳LLM、两级判句、串行、失败重试去 response_format、JSON 围栏剥离）· 共情转换链 · 耦合（事件传播+tick阻尼，系数0待跑一周）· 17特殊状态 · 思念/无聊（A/B双路冷却）· 掷骰敲门（v1 sigmoid 曲线、夜里停、80直提、60分钟冷却、skipRoll）· 摘要搭车（敲门时带）· 注入（状态条+敲门，均带 source 标记）· 面板（药丸 dock + 卡片 shell.overlay + 日志页）· 三工具（mood_log/mood_rollback/mood_baseline）· Config 用 Schema.object。

审计修复全部完成：A1 时区、A2 日志并发丢行、A3 基线生效、A4 cap、A5 修饰统一、A6 传播随结算、**A7 数值真回滚**、A8 管道转义、B1 来源判定、B2 source 标记、B3 离线冻结、B4 判官健壮性、C1/C2/C3、待办5③护着（方向判定）、数据文件 BOM 容错。

---

## 5. 相对 SPEC 的实现偏差（用户拍过板的）

| SPEC 原文 | 实际实现 | 谁定的 |
|---|---|---|
| 衰减按真实时间 | **B3 冻结**：dt 夹到一跳内，离线不补衰减 | 用户 |
| 判官第二轮带 10 个来回（10 分钟窗） | 只用**用户消息流**（插件自记 buffer），**20 分钟**窗、最多 10 条、不足不往前补 | 用户 |
| 摘要搭状态条 | 摘要只在**敲门**时带；状态条/敲门都重置摘要段 | 用户 |
| 「护着」against offender（认人） | 方案③：不认人，护着期间 about=other 的怒 ×1.1 | 用户 |
| 日志五列 | **六列**：时间（记录）｜情绪｜变化｜原因｜状态｜生效（衰减起点）。主条日志在**结算时**写（一行=一笔真实入账） | 用户（A7 要求双时间） |
| 判官生命周期管理（探测/拉起/5分钟停） | **没做**——插件只调用，不管 vLLM 进程 | 未讨论，低优先 |
| 「护着」数据里的 against 字段 | 保留在数据里不消费 | 方案③附带 |

---

## 6. 剩余待办（按优先级）

1. **装 v2**（等用户发话）。装法：用户会话里说装，然后 profile 的 link 从 dsh-mood-changes 换到 dsh-mood（`plugin_manager install_bundle F:\DSH\work\plugins\dsh-mood`，或直接改 profile package.json 的 link 指向 + bundles 名换成 dsh-mood）。注意 v2 的 bundle 名是 `dsh-mood`、patch id 也是 `dsh-mood`。
2. **装后运行时验证**：
   - B1 实测：QQ 桥转一条群消息 + 一条主人私聊，确认思念只对后者掉
   - B2 实测：等一次注入，确认 `plugin:dsh-mood` 标记生效（自己不判自己）
   - 面板：药丸出现、卡片点开、日志页可查
   - 工具：模型能看到 mood_log/mood_rollback/mood_baseline
   - 判官：发一句带情绪的话，看日志里有没有她的情绪入账（300-700ms 延迟正常）
3. **vLLM 常驻方案**——问用户：一键脚本 / 开机自启 / 不管
4. **三个小功能缺口**：`alsoMissing`（孤独额外加思念）、`closeOnly`（害臊的亲近权重）、`skipDecay`（轻快跳过 2 次衰减）——emotions.json 里有标记，代码没消费
5. 短词缓存**已取消**（词表本就微秒级）——别再做
6. 7B AWQ 未测（3B 够用可以先不动）

---

## 7. 关键坑（下个会话别踩）

1. **Config 必须 `Schema.object`**（`import Schema from '@deepseek-ai/schemastery'`，profile node_modules 里有 3.18.5）。普通对象导出会启动失败：`Cannot read properties of undefined (reading 'validate')`——v2.0.0 就死在这。
2. **data/*.json 带 UTF-8 BOM**——所有读取已容错（`raw.replace(/^\uFEFF/, '')`），别新增裸 `JSON.parse(readFile(...))`。
3. **log.js 有内部串行链**（`_chain`）——并发安全靠它，写入一律走 `append`/`appendBatch`/`rollback`，别绕过直接写文件。写入是原子写（tmp+rename）。
4. **消息 source 形状**：
   - DSH 输入框：`source.kind === 'user'`
   - QQ 桥：`source.kind === 'plugin:dsh-qq-bridge'`（旧版 'plugin'），文本格式 `[QQ · 群名/私聊] 昵称：内容`
   - 本插件注入：`source.kind === 'plugin:dsh-mood'`（handleMessage 靠它跳过自己）
5. **PowerShell 的 JSON/引号序列化很坑**——端到端测试一律写 node 脚本放 `_tmp`，import 用 `file:///F:/...` URL（Windows 绝对路径 import 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME）。
6. **agent.inject 的消息**：`{ role:'user', content:[{type:'text',text}], source:{kind:'plugin:...'} }`（照 qq-bridge 的形状）。
7. **文件全放 F 盘**：venv、模型、tmp 都在 F；用户明令不写 C/D。
8. **测试命令**（node 在 `F:\DSH\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`）：
   - `F:\DSH\work\_tmp\mood-smoke\run.mjs` —— 9 项基础 smoke（时区/并发/转义/cap/传播）
   - `F:\DSH\work\_tmp\mood-smoke\rollback-test.mjs` —— A7 回滚链路
   - `F:\DSH\work\_tmp\mood-smoke\judge-test.mjs` —— 判官真机（需 vLLM 在跑）
   - 语法：14 个 JS 文件 `node --check`

---

## 8. 用户的工作约定（重要）

- **全程中文**，思考和回复都是
- **拿不准就问，不私自决定**——尤其涉及装/卸/改配置
- **装插件必须用户发话**（"在我发话前不装"）
- 改完必须**自己验证**（测试/运行时检查），不许"应该可以了"交差
- commit 信息用中文；git 操作在 dsh-mood-main（main）/ dsh-mood-changes（v1）各自做
- 修改 profile 的 cordis.patch.yml 可以做（v1.8.1 时加过 ownerNames），但那是用户层，谨慎

---

## 9. 文件地图

```
F:\DSH\work\plugins\dsh-mood\        ← v2 开发目录（v2.2.0）
├── SPEC.md           v0.1 设计稿（历史参考）
├── KNOWN-ISSUES.md   审计清单（A/B/C 项修复状态）
├── HANDOVER.md       本文档
├── index.js          Host 入口（tick/判句/结算/敲门/注入）
├── client.js         面板（dock 药丸 + shell.overlay 卡片）
├── lib\
│   ├── store.js      state/baseline 读写（原子写+BOM容错）
│   ├── pool.js       六情池（半衰期；导出 HALF_LIVES_MS 给回滚用）
│   ├── judge.js      判官（串行链+两级+围栏剥离+重试）
│   ├── empathy.js    他→她转换
│   ├── log.js        六列日志（串行链+appendBatch+回滚账面）
│   ├── coupling.js   传播（乘 mods）+阻尼
│   ├── missing.js    思念（含 shouldKnock sigmoid）
│   ├── boredom.js    无聊（A/B 冷却+shouldKnock）
│   ├── states.js     17 状态（含 protectionFactor=护着③）
│   ├── statusbar.js  注入（source 标记+knock）
│   ├── routes.js     /api/mood/state + /api/mood/log
│   └── tools.js      三工具（mood_rollback 含数值重放）
├── data\             数据契约（emotions/empathy/lexicon/judge-*/baseline/log-template 六列版）
└── locale\ icon.svg docs\
```

桌面有用户看的精简清单：`C:\Users\fan\Desktop\dsh-mood 修复清单.md`（改完记得同步更新）。
