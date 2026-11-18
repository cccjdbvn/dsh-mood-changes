# Mood changes（dsh-mood-changes）

把「此刻是什么味道」记成一条随时间走的状态：思念、六情（开心 / 悲伤 / 害怕 / 生气 / 惊讶 / 厌恶）、无聊，每 15 分钟一跳，半衰期自己退。输入框下面一枚小药丸写着当前状态，点开是一张卡，各条都在。

一句铁律：**它只敲门，不替人开口。** 弹出来的、投进去的全是状态和数字，没有一句台词。

## 长什么样

- **药丸**（输入框下面）：写着此刻的名字——亮起的组合名（悲喜交加、又好气又好笑……）、20–40 之间最高的那一条、或者「平静」。
- **卡片**（点药丸弹出来）：大字状态名、一行「几点算的 · 几分钟前 · 亮着几条」、六情六根横杆加数值，隔一条缝是思念 / 无聊。点外面或按 Esc 关。

| 情绪 | 存的名字 | 条的颜色 |
| --- | --- | --- |
| 开心 | `happy` | 金 |
| 悲伤 | `sad` | 蓝灰 |
| 害怕 | `fear` | 紫 |
| 生气 | `anger` | 红 |
| 惊讶 | `surprise` | 青 |
| 厌恶 | `disgust` | 橄榄 |
| 思念 | `missing` | 粉 |
| 无聊 | `boredom` | 灰 |

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
| `life.json` | 别的插件 | 只读里面的 `homeSessionId`，决定往哪个会话投 |
| `$DSH_HOME/mood/state.json` | 插件 | 当前值 + 时间戳，唯一的真源 |
| `$DSH_HOME/mood/mood.log` | 插件 | 每跳一行，出事好查 |

## 哪些数值可以改

改在哪：profile 的 `cordis.patch.yml` 里 `- id: dsh-mood-changes` 那一行的 `config:`。没写的就是默认。

### 路径和去处

| 键 | 默认 | 改了会怎样 |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/mood` | 状态和日志放哪。换地方等于换一套账，旧的不跟过来 |
| `worldId` | 空 | 填了就接世界（吃加分、读 `life.json`、往会话投）；空着只显示状态 |
| `roomDir` | `$DSH_HOME/worlds/<worldId>/room` | 单独指房间，覆盖推导 |
| `lifeFile` | `$DSH_HOME/worlds/<worldId>/life.json` | 单独指 `life.json`，覆盖推导 |
| `sessionId` | 空 | 写死投给哪个会话，不再跟 `life.json` 走——换会话就得来改 |

### 节拍

| 键 | 默认 | 改了会怎样 |
| --- | --- | --- |
| `sweepEveryMinutes` | 15 | 心跳：多久衰减一次、多久收一次加分、多久涨一次钟点分。改小退得更勤更碎，改大一次掉更多 |
| `pollSeconds` | 30 | 多久扫一次那两个 `.now` 文件（核算、做事） |
| `decimals` | 1 | 落盘和显示几位小数；只影响记下来和看到的样子，不影响算法 |
| `nightStart` / `nightEnd` | 23 / 7 | 夜里那段（跨零点照写）。思念在这段打 `nightMultiplier` 折，无聊不涨 |
| `nightMultiplier` | 0.4 | 夜里思念涨多少倍；设 0 = 夜里完全不涨 |

### 六情怎么加减、怎么退

| 键 | 默认 | 改了会怎样 |
| --- | --- | --- |
| `joyHalfLifeHours` | 5 | 开心退一半要几小时。越小退得越快 |
| `sadHalfLifeHours` | 10 | 悲伤，同上 |
| `fearHalfLifeHours` | 12 | 害怕，同上 |
| `angerHalfLifeHours` | 6 | 生气，同上 |
| `surpriseHalfLifeHours` | 2.5 | 惊讶，同上 |
| `disgustHalfLifeHours` | 30 | 厌恶，同上 |
| `capHigh` | 100 | 悲伤 / 害怕 / 生气 / 惊讶的显示上限 |
| `capNormal` | 100 | 开心 / 厌恶的显示上限（开心实际落盘 99.9，碰不到 100） |
| `lightUpAt` | 40 | 超过这个值算「亮起」：决定药丸上出不出现组合名、要不要往会话里注一条 |
| `calmBelow` | 20 | 最高那条不到这个数就写「平静」 |
| `nearGap` | 5 | 暂时用不到（20–40 那段现在只取最高那一条），留给以后 |

### 思念和无聊

| 键 | 默认 | 改了会怎样 |
| --- | --- | --- |
| `manualDailyCap` | 40 | 思念一天手动加分的上限；**只封思念**，六情不封 |
| `rollEveryMinutes` | 45 | 思念和无聊多久掷一次骰子 |
| `rollCooldownMinutes` | 60 | 提醒之后多久不再提醒（两条线各算各的） |
| `boredomPerHour` | 6 | 无聊每小时涨多少（按 `sweepEveryMinutes` 折算到每跳）；夜里不涨 |
| `boredomDropFactor` | 0.5 | 有行动时无聊乘多少；0.5 = 减半，0 = 直接清零 |
| `boredomDropCooldownMinutes` | 60 | 两次减半之间至少隔多久 |
| `boredomRollFrom` | 50 | 无聊到这个值才开始掷骰 |
| `boredomDirectFrom` | 80 | 无聊到这个值不掷、直接提醒 |

### 注入节奏

| 键 | 默认 | 改了会怎样 |
| --- | --- | --- |
| `injectGapMinutes` | 60 | 六情亮起两次注入之间至少隔多久。思念、无聊的提醒不占这个名额 |
| `activeCooldownMinutes` | 10 | 两次主动核算之间至少隔多久；这期间再按只记一笔日志，分留在文件里不乱动 |

### 改不了、写死在代码里的

三档的分值范围、15 组组合名、思念和无聊共用的那条概率曲线 `p(x) = 1/(e^(6.25-0.1x)+1)`、开心的积分变换——这些是规则本身，要动就得改 `index.js`。

## 加分文件

一行一条，一次加总：

```
happy+5
sad+3
anger-2
```

`happy` / `sad` / `fear` / `anger` / `surprise` / `disgust` / `missing` 对应上表的中文名；`boredom` 不许手写（写了会被丢，日志里记一笔）。减分直接在分数上减，不走开心的积分。

## 规矩

- 不替人写话、不替人发消息，只报状态。
- 状态文件坏了先备份成 `state.json.broken-<时间>` 再从零起，日志里写明。
- 只读 `life.json`，不改别人的东西。

## 授权

MIT，版权归汐涟。见 `LICENSE`。
