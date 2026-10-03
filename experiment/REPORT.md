# 提示词实验：压缩「推理预算」段落能不能让快速模式更省

> **后续（2026-10-03）**：基于本报告的阴性结论，用户决定**删掉** `reasoning-budget` 插件，
> 而不是在两臂间二选一。插件本体保存在 `arms/reasoning-budget.removed.mjs`，
> patch 行的复原注释见 `profile/live-cordis.patch.yml:89-100`。删后新会话已实测
> `system/message` 里不再出现该段落。本报告正文保持删除前的原样，作为决策依据。

**结论：不能。** 把 `reasoning-budget` 的提示词从 827 字符砍到 410 字符（0.496×，
含更高压缩的措辞、更硬的语气、以及一条「每步硬上限 60 词」的量化指令），
推理量在统计上**没有任何可检出的变化**：每步推理字符数 B/A = **0.975×**
（95% CI 0.73–1.31），标记密度 B/A = **1.07×**（95% CI 0.77–1.48）。
两臂的唯一真实差异是**会话总时长/步数**（11.75 vs 9.58 步，B/A = 0.87，p≈0.14），
而这是**任务规模**的噪声，不是提示词造成的（见下「为什么这不是效果」）。

英文版摘要见 `README.md`。

---

## 被试提示词（唯一自变量）

插件 `C:\Users\rain\.dsh\profiles\desktop\reasoning-budget.mjs` 往系统提示里挂一个
`## Reasoning budget` 段落。它的头注自己写着：

> nothing in the recorded sessions proves the model obeys such a contract …
> Treat the effect as unverified until an A/B on live sessions measures reasoning
> characters per step.

本次实验就是它要求的那次 A/B。

| | arm A（对照） | arm B（处理） |
| --- | --- | --- |
| 文件 | `arms/rb-armA.mjs` | `arms/rb-armB.mjs` |
| 文本 | 就是当前部署的 `DEFAULT_TEXT`，**逐字节相同** | 新写的更短版本 |
| 长度 | 827 字符 | **410 字符（0.496×）** |
| 识别 needle | `Reasoning is private and is not the deliverable` | `Private reasoning is cost you cannot ship` |
| 关键差异 | 「每步 ~300 词以内」 | 「每步硬上限 60 词」「工具调用前最多两句」 |

arm B 全文 5 行：

```
## Reasoning budget

Private reasoning is cost you cannot ship. Converge hard.

- Decide once. Never restate, re-derive, or re-verify anything already established in this session.
- Do not write alternatives you will not take. Name the chosen action and stop.
- Reasoning before a tool call: at most two sentences.
- Hard cap: 60 words per step. If you are over, you are already wrong — cut, and call the tool.
```

## 方法

- **只影响快速模式**（用户硬约束：不许动、不许跑其他预设）。
  `reasoning-budget` 在 profile patch 里是**全局**挂载的
  （`cordis.patch.yml:92-96`），直接改它或它的 config 会连带 standard 与创造模式一起变。
  合规做法只有一种：`@deepseek-ai/dsh-system-prompt/lib/index.js:242` 规定
  「A scoped section shadows a global section with the same name」，
  于是给 `preset-bash-first` 的 `plugins:` 数组里挂一个**同名** section 实例来遮蔽全局那一个。
  这个遮蔽机制**已被端到端证伪/证实**（shadow-marker 探针：bash-first 会话读到 scoped 文本、
  standard 会话读到全局文本、双向零泄漏）。
- **被试任务固定**：`fixture/` 是一个 193 行、自足的小 Node 项目，
  埋了 4 个可证明的逻辑缺陷（`lib/util.js:sum` 与 `src/report.js:summarize` 的 off-by-one、
  `lib/store.js:put` 两个分支都 push `action:'insert'`、`lib/pricing.js:tierRate` 对未知档返回 `undefined`）。
  每张卡都用**逐字相同**的 prompt 要求：读全部 `.js`、找出全部逻辑 bug、每个用 `node -e` 证明、
  不许改 fixture、末尾报总数。
- **通道**：DSH 没有非交互 CLI。用 `task_board` 卡固定 `mode: "bash-first"`，
  一张父卡 + 11 张子卡，一次 `task_board_run` 级联起 12 个会话；
  两臂分阶段串行（patch 里只有一条 scoped 行）。
- **样本**：arm A 12 个会话 / 141 步 / 545,300 字符；
  arm B 12 个会话 / 115 步 / 433,294 字符。全部 `effort=high`、全部 `hasPwsh=False`。
- **臂归属由会话系统提示里的 needle 判定**，不靠批次的先后 —— 误切换无法悄悄污染数据。
- **端点**：主端点 `log10(每步推理字符数)`（每会话取几何均值）；次端点「重开/犹豫」标记
  （`\bwait\b|\bactually\b|hold on|\bin fact\b|\bhowever\b|\bbut wait\b`）密度。
  统计按**会话**为单位（步与步之间相关），Welch t + 95% CI。

## 结果

| 端点 | arm A | arm B | B/A | t | 95% CI |
| --- | --- | --- | --- | --- | --- |
| 推理字符/步 | 3,662.8 | 3,724.1 | **0.975**（log 尺度） | −0.12 | 0.73 – 1.31 |
| 标记/步 | 2.76 | 3.11 | 1.07 | −0.73 | 0.77 – 1.48 |
| 标记/会话 | 34.5 | 30.1 | 0.87 | +0.55 | 0.40 – 1.35 |
| 字符/会话 | 45,442 | 36,108 | 0.79 | +0.97 | 0.36 – 1.23 |
| 步/会话 | 11.75 | 9.58 | 0.87 | +1.52 | 0.57 – 1.07 |

pooled 口径（不分会话、直接汇总所有步）：字符/步 3,867 → 3,768（0.974×），
标记/步 2.94 → 3.14（1.07×）。

**没有任何端点显著，也没有任何一个的 CI 排除 1.0。** 两臂的分布几乎重合：
A 的中位步 3,550 字符 vs B 的 3,603；`≤400 字符` 的步占 22.0% vs 18.6%；
`≥8,000 字符` 的「胖步」占 17.3% vs 17.6%。

### 为什么会话总字符数少了 21% 不是效果

看上去 arm B 省了 9,334 字符/会话（−21%），但：

1. p≈0.34，95% CI 是 0.36–1.23，**什么都没排除**。
2. 每步强度**完全没变**（0.975×）。会话总字符 = 步数 × 每步字符，
   所以差异只能来自**步数**，而步数差异来自**任务被做多大**，不是来自模型多想。
3. 该效应的方向与「提示词变短应该更省」无法区分于「这次凑巧少探了几个分支」——
   arm A 里 `exp-A-b10` 一个会话就跑了 19 步 / 96,286 字符，它单独贡献了 A 总量的 16%。
4. arm B 的 `good` 会话与 arm A 的 `good` 会话产出**同样的东西**
   （两臂都稳定报出 5–8 个 bug、都引用 4/4 个文件、都给出可复现的 `node -e` 证明），
   即没有「省下来的推理换来了更差的产出」。

### 最直接的证据：60 词上限被无视

arm B 唯一的**可机械检验**的指令是「每步硬上限 60 词」。arm B 每步推理的
**中位数是 3,603 字符 ≈ 700 词**，是上限的 **11.7×**；只有 18.6% 的步落在 400 字符以内。
也就是说，模型系统性地、几乎每一步都突破了这条明写的量化上限，
而输出质量没有因此变差、推理量也没有因此变多或少。
**这是本次实验最干净的一个结论：这类自然语言「预算约束」对推理长度没有执行力。**

### 检验功效（为什么「没效果」是可信的而不是样本不够）

n=12/臂、80% 功效下能检出的最小差异：

- 字符/会话：27,007 字符 = 均值的 **66%**
- 标记/步：1.34 = 均值的 **46%**

也就是说这批样本**检不出小于 ~46% 的效应**，因此：
**能排除的是「大幅压缩推理」的假设，不能排除 10–20% 的温和效应。**

但这个功效上限本身并不削弱结论，因为方向是**反的**：
log 尺度点估计 B 比 A **高** 2.5%，标记/步 B 比 A **高** 7%。
如果提示词真有任何作用，方向也应当是 B 更低。观测到的不是「效应小」，
而是「没有效应 + 噪声占了主导」。

要真正锁死 ±25% 的效应，标记端点需要 ~13 会话/臂（本次 12 已接近），
字符端点需要 ~108 会话/臂 —— 这正是当初功效分析选标记作主端点的原因，
本次实测复现了该量级。

## 结论与建议

1. **`reasoning-budget` 这个插件对推理长度没有可测效果。** 它自己头注里
   「Treat the effect as unverified」的诚实声明，本次 A/B 给出的答案是：
   在快速模式下，827 字符与 410 字符两种措辞都**不改变**模型的推理量。
2. **不要用这类提示词去省推理。** 省字数的路子不在这里 —— 按早期测量，
   推理占输出字符的 69.6%，模型生成占一步耗时的 91.8%，
   所以只有**真的少生成 token** 才有意义，而提示词劝告做不到。
3. **保留还是删掉？** 从本次证据看，该段落是无害的（不拖慢、不改质量），
   但也是无效的。既然它自认「unverified」而 A/B 结果为阴性，
   建议要么删掉（少 827 字符的系统提示，换一点前缀缓存空间），
   要么按插件头注的要求把它标记为「已验证无效果」而不再是「待验证」。
4. **本次实验未触及** standard 与创造模式（用户硬约束），
   实验期间这两者的行为与被试文本**逐字节未变**，实验结束后 profile patch
   已恢复为实验前的**逐字节相同**状态（`cmp` 通过）。

## 复现

```powershell
cd "E:\fast deepseek harness\experiment"
node set-arm.mjs A          # 或 B / off / check
# 然后用 task_board 跑 exp-A-batch-parent / exp-B-batch-parent 那两张卡
python collect.py           # 按臂聚合；--json 出原始行
python analyze.py <session-id>
```

- `set-arm.mjs` 按**结构**定位 scoped 行（先找 `- id: preset-bash-first`，再找其下 `plugins:`，
  再按缩进找直接子行），不按行号；每次打印 `global reasoning-budget row still present: true` 自证。
  它包含**从零插入**分支 —— 这一点是必需的，早期版本缺该分支，一次误操作 `off`
  就把可逆实验变成了不可逆（该缺陷已修）。
- 会话记录是 `C:\Users\rain\.dsh\sessions\*\session.v4.jsonl.zstd`。
  **必须用 `zstandard` 的 `stream_reader`** —— `ZstdDecompressor().decompress()`
  会报 `ZstdError: could not determine content size in frame header`。
- 判定臂归属要**按键解析 JSON**（`type == "system/message"` 的 `data.message.content`），
  **不要**对整份 jsonl 做字符串搜索 —— transcript 里记着你自己敲过的命令，
  含 marker 字面量，会造成假阳性（本次踩过）。

## 文件

| 路径 | 内容 |
| --- | --- |
| `arms/rb-armA.mjs` | 对照臂插件（827 字符，= 部署中的 `DEFAULT_TEXT`） |
| `arms/rb-armB.mjs` | 处理臂插件（410 字符） |
| `set-arm.mjs` | 臂切换器：`A\|B\|off\|check`，结构定位 + 从零插入 + 自证 |
| `fixture/` | 固定被试任务（193 行，4 个可证缺陷） |
| `task.txt` | 逐字固定的卡片 prompt |
| `collect.py` | 按 `session/title` 前缀聚合两臂 |
| `analyze.py` | 单会话指标 |
| `runs/ab.json` | 24 个实验会话的原始逐会话指标 |
| `runs/summary.json` | 汇总 |
