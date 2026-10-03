# experiment/ —— 「压缩推理预算提示词」A/B 实验

**问题**：把快速模式系统提示里的 `## Reasoning budget` 段落从 827 字符压到 410 字符
（并加一条「每步硬上限 60 词」的量化指令），能不能让模型少写推理？

**答案：不能。** 每步推理字符 B/A = 0.975×（95% CI 0.73–1.31），
标记密度 B/A = 1.07×（0.77–1.48）—— 两个端点都不显著，CI 都不排除 1.0。

完整方法、数据、功效分析与建议见 **[REPORT.md](REPORT.md)**。

## 这里有什么

| 路径 | 内容 |
| --- | --- |
| `REPORT.md` | 主报告：被试提示词、方法、结果表、机制解释、功效分析、结论 |
| `arms/rb-armA.mjs` | 对照臂（827 字符，**逐字节等于**部署中的 `DEFAULT_TEXT`） |
| `arms/rb-armB.mjs` | 处理臂（410 字符 = 0.496×，含 60 词硬上限） |
| `armA.md` / `armB.md` | 两臂提示词段落的可读形式（`.mjs` 里是同一文本） |
| `set-arm.mjs` | 臂切换器：`node set-arm.mjs A\|B\|off\|check` |
| `fixture/` | 固定被试任务：193 行自足 Node 项目，埋 4 个可证缺陷 |
| `task.txt` | 逐字固定的卡片 prompt（两臂完全相同） |
| `collect.py` | 按 `session/title` 前缀聚合两臂；`--json` 出原始行 |
| `analyze.py` | 单会话指标：`--tag A\|B <session-id>`、`--arm A`、`--list` |
| `arm-batch.mjs` | 生成批量卡计划 JSON |
| `runs/ab.json` | 24 个实验会话的逐会话原始指标 |
| `runs/summary.json` | 汇总 |
| `arms/reasoning-budget.removed.mjs` | 被删掉的插件本体（75 行 / 4,268 B），留作复原素材 |

## 后续（2026-10-03）：插件已按实验结论下线

实验做完后，用户决定**删掉**这个插件，而不是在 A/B 两臂间选一个：

- 宿主 `C:\Users\rain\.dsh\profiles\desktop\reasoning-budget.mjs` 已删除，留下本目录的
  `arms/reasoning-budget.removed.mjs` 作为唯一副本（4,268 B，`cmp` 通过）。
- 它的 profile patch 行（原本是第一处 `- insert:`）已换成一段 12 行留痕注释，
  见 `profile/live-cordis.patch.yml:89-100`，注释里含恢复用的原行 4 行。
- 删除前状态备份：`profile/cordis.patch.yml.bak-before-rb-removal`（35,002 B / 699 行）。
- 删后新会话实测：`system/message` 里 `Reasoning budget` / `re-open` / `settled decisions`
  全部 absent（对照旧探针 13,740 字符的 system message 里该段落位于偏移 12964）。
- 依据就是本实验的阴性结论 —— 该段落对推理长度无任何可测效果，而它是**全局**挂载，
  standard 与创造模式也一直在为这 827 字符付费。

## 关键操作约束（踩过的坑）

1. **只能遮蔽，不能改全局。** `reasoning-budget` 在 profile patch 里是全局挂载的
   （`cordis.patch.yml:92-96`），直接改插件或它的 config 会连带 standard 与创造模式一起变。
   唯一合规做法是往 `preset-bash-first` 的 `plugins:` 里挂一个**同名** section 实例 ——
   按 `@deepseek-ai/dsh-system-prompt/lib/index.js:242`，同名 scoped section 会遮蔽全局那个。
   **`set-arm.mjs` 是唯一允许的编辑入口**，它按结构定位（先找 `- id: preset-bash-first`，
   再找其下 `plugins:`，再按缩进找直接子行），不按行号；每次打印
   `global reasoning-budget row still present: true` 自证。**用行号做这类编辑是错的。**
2. **两臂必须分阶段串行**：patch 里只有一条 scoped 行，指向一个模块路径。
   跑完一臂 `set-arm.mjs` 切到另一臂，再跑另一臂的卡。
3. **跑卡通道**：DSH 没有非交互 CLI（`dsh-desktop-next` 无 `bin`，`@deepseek-ai/dsh/lib/bin.js`
   无 `--preset`/`--print`/`--headless`），所以用 `task_board` 卡固定 `mode: "bash-first"`。
   一张父卡 + 11 张子卡，**一次 `task_board_run` 会级联起父卡自己 + 每个直接子任务的会话**。
   `workspaceId` 必须是真实 id（`E:\fast deepseek harness` =
   `09f50cfa-a2d5-4a67-ac66-951f68f33846`），写 `"default"` 会 `workspace not found`。
4. **收集实验会话按 `session/title` 前缀筛**（卡 title 会成为会话 title），
   **不要**对 jsonl 全文做字符串搜索 —— transcript 里记着你敲过的命令，含 marker 字面量，会假阳性。
5. **臂归属要按键解析 JSON 判定**，不信批次先后：arm A 文本含
   `Reasoning is private and is not the deliverable`，arm B 含
   `Private reasoning is cost you cannot ship`，两者都在 `type == "system/message"` 的
   `data.message.content` 里可检出。误切换因此无法悄悄污染数据。
6. **读会话记录必须用 `zstandard` 的 `stream_reader`** ——
   `ZstdDecompressor().decompress()` 会报
   `ZstdError: could not determine content size in frame header`。
7. **别用 shell heredoc 写含中文的 `.py`**（会变成非 UTF-8，`SyntaxError: Non-UTF-8 code starting with '\xe4'`）。
   用编辑工具写。

## 跑一遍

```powershell
cd "E:\fast deepseek harness\experiment"

# 1. 上臂（两臂依次跑，不要并行）
node set-arm.mjs A
# 2. 用 task_board 跑卡 exp-A-batch-parent（父 + 11 子一次级联）
# 3. 收集
python collect.py                 # 按臂聚合
# 4. 换臂再跑
node set-arm.mjs B
# ... 跑 exp-B-batch-parent ...
python collect.py

# 收尾：恢复现场，并核对逐字节一致
node set-arm.mjs off
cmp "C:\Users\rain\.dsh\profiles\desktop\cordis.patch.yml" `
    "E:\fast deepseek harness\fast-mode-preset\profile\live-cordis.patch.yml"
```

`set-arm.mjs` 含**从零插入**分支（找不到 scoped 行时会重建它）。这一点是必需的：
早期版本没有该分支，一次 `off` 就把可逆实验变成了不可逆，只能手工重建。
