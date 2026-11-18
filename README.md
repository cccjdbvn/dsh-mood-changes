# Mood changes（dsh-mood-changes）

把「此刻是什么味道」记成一条随时间走的状态：思念、六情（乐悲惧怒惊厌）、无聊，每 15 分钟一跳，半衰期自己退。输入框下面一枚小药丸写着当前状态，点开是一张卡，各条都在。

一句铁律：**它只敲门，不替人开口。** 弹出来的、投进去的全是状态和数字，没有一句台词。

![情绪卡](#) <!-- 截图待补 -->

## 长什么样

- **药丸**（输入框下面）：写着此刻的名字——亮起的组合名（悲喜交加、又好气又好笑……）、20–40 之间最高的那一条、或者「平稳」。
- **卡片**（点药丸弹出来）：大字状态名、一行「几点算的 · 几分钟前 · 亮着几条」、六情六根横杆加数值，隔一条缝是思念 / 无聊。点外面或按 Esc 关。

## 装

市场里搜 **Mood changes**，或者把仓库 clone 下来，在插件管理里用目录安装。

装完不需要任何配置：状态存在 `$DSH_HOME/mood/`（没有 `DSH_HOME` 就用 `~/.dsh/mood`），药丸立刻能用。

## 接世界（可选）

不接世界时，它只显示状态、不往会话里注入。要让它敲门，配置一个 `worldId`：

```yaml
- id: dsh-mood-changes
  config:
    worldId: lian
```

于是它去 `$DSH_HOME/worlds/<worldId>/` 下读写：

| 文件 | 谁写 | 说明 |
| --- | --- | --- |
| `room/情绪-加分.txt` | 你 | 一行一条：`happy+5`、`sad-3`、`anger+26`。每跳吃一次，吃完清空 |
| `room/情绪-核算.now` | 你 | 建一个空文件 = 现在算一下（30 秒内被吃掉） |
| `room/情绪-做事.now` | 你 | 建一个空文件 = 刚做了点事，无聊减半 |
| `worlds/<id>/life.json` | 别的插件 | 只读里面的 `homeSessionId`，决定往哪个会话投 |
| `$DSH_HOME/mood/state.json` | 插件 | 当前值 + 时间戳，唯一的真源 |
| `$DSH_HOME/mood/mood.log` | 插件 | 每跳一行，出事好查 |

路径都可以直接配：`dataDir`、`roomDir`、`lifeFile`，配了就不推。

## 规则（可选参数）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `sweepEveryMinutes` | 15 | 多久收一次手动加分、跳一次 |
| `nightStart` / `nightEnd` | 23 / 7 | 夜里那段（思念 ×0.4、无聊不涨） |
| `manualDailyCap` | 40 | 思念一天的手动加分上限；六情不封顶 |
| `joyHalfLifeHours` … `disgustHalfLifeHours` | 5 / 10 / 12 / 6 / 2.5 / 30 | 六情的半衰期（小时） |
| `capHigh` / `capNormal` | 100 / 100 | 显示上限（乐落盘 99.9） |
| `lightUpAt` / `calmBelow` / `nearGap` | 40 / 20 / 5 | 亮起线、平稳线、取名范围 |
| `rollEveryMinutes` / `rollCooldownMinutes` | 45 / 60 | 思念和无聊的骰子 |
| `injectGapMinutes` | 60 | 六情两次注入之间 |
| `activeCooldownMinutes` | 10 | 两次主动核算之间 |
| `pollSeconds` | 30 | 多久扫一次那两个 .now 文件 |
| `boredomPerHour` / `boredomDropFactor` / `boredomDropCooldownMinutes` | 6 / 0.5 / 60 | 无聊涨多少、减半、冷却 |
| `boredomRollFrom` / `boredomDirectFrom` | 50 / 80 | 无聊的门槛 |

## 规矩

- 不替人写话、不替人发消息，只报状态。
- 状态文件坏了先备份成 `state.json.broken-<时间>` 再从零起，日志里写明。
- 只读 `life.json`，不改别人的东西。

## 授权

MIT，版权归汐涟。见 `LICENSE`。
