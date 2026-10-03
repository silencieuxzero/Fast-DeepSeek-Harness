# `analysis/` — 快速模式立项时的测量脚本

这里放的是当初回答**「该不该做一个 bash-first 的快速模式」**时写的分析脚本。
它们只读 `C:\Users\rain\.dsh\sessions\*\session.v4.jsonl[.zstd]`，
从真实会话记录里量出 shell 失败率、失败成因、耗时去向与推理预算，不写任何宿主文件。

| 脚本 | 覆盖内容 |
| --- | --- |
| `shell-error-audit.py` | 按 shell 工具名分组统计命令失败率。按 `callId` 把 `tool/call` 与 `tool/result` 配对，把失败文本归成命名模式，给出每个 shell 的失败率 |
| `shell-error-audit.mjs` | 同上，Node 版（用 Node ≥ 22 的 zlib 直接读 `.jsonl.zstd`） |
| `shell-cause-classify.py` | 把 shell 失败**按成因**分成 authoring（模型自己把命令写错：引号/转义、解析错误、调用形式不对、内联代码有 bug）与 factual（命令没问题，是世界说不：路径不存在、搜索无匹配、环境缺二进制、超时） |
| `shell-failure-triage.py` | 逐条 dump 每个失败连同它的命令行，人眼复核上面两类的分界 |
| `shell-grammar-report.py` | 互斥分类版：grammar（**shell 本身拒绝**了模型的命令语法）vs runtime（命令合法且跑起来了，世界说不）。特别排除「程序只是打印了像错误的东西」这类假阳性 |
| `shell-grammar-final.py` | 定稿版量法：self-inflicted 失败必须是 **shell 自己的抱怨**，即模式要出现在 `[stderr]` 区域，或（无该标记时）落在退出码非零的记录里。**这是最终采用的判定标准** |
| `step-timing.py` | 一步的墙上时间花在哪、prompt 缓存命中多少。`stream[0].time` = 请求开始、`stream[-1].time` = 响应结束，`usage` 里的 `cacheReadTokens` 给前缀缓存命中率 |
| `mistype-strict.py` | 严格版「模型把命令写错了吗」判定：只计 **shell 自己抱怨命令文本畸形**（bad substitution / unexpected EOF / ParserError …），并显式**排除**「程序只是打印了像错误的东西」这类假阳性。逐条 dump 命中样本供人眼复核 |
| `mistype-conditional.py` | 在严格版之上加**条件比较**：把「命令里嵌了内联程序（`node -e` / `python -c` / `perl -e` / `pwsh -c`）或带引号路径」这一构造成本更高的子集单独拆出来算，检验两把 shell 的失败率是否只是被试难度不同造成的 |
| `mistype-final.py` | **定稿量法**，把两种失败刻意分开：**A. shell-grammar**（命令没 parse 就被 shell 拒绝，= 用户说的「输错命令」；要求 shell 的抱怨出现在 `[stderr]` 区域，或（无该标记时）落在退出码非零的记录里）与 **B. program-bug**（命令解析没问题，是模型嵌在里面的程序有 bug）。按 shell、按会话、并给 leave-one-session-out 视图，防止单个大会话把率扛起来 |

## 结论（作为快速模式立项依据的那三组数）

- **shell 语法错误率**：pwsh 43/1456 = **2.95%** vs bash 4/275 = **1.45%**。
  但 bash 那 4 次按 stderr 判定**全是假阳性**（一个审计脚本本身在打印捕获到的 PowerShell 错误文本），
  所以 bash 的真实自伤率 ≈ **0%**。
- **归因到模型自己写错**：pwsh 36 次 = **2.5%**、bash 2 次 = **0.7%**。
- **定稿口径（`mistype-final.py`，扩到全部会话后重跑）**：只看 **A. shell-grammar**（命令没 parse 就被
  shell 拒绝），pwsh **17/1437 = 1.18%** vs bash **12/1262 = 0.95%**；而 bash 那 12 次**全部集中在同一个
  会话**里，leave-one-session-out 去掉它之后是 **0/554 = 0.00%**，pwsh 去掉最大会话后仍有 10/962 = 1.04%。
  同一批数据里 **B. program-bug**（命令没写错，是内联程序有 bug）bash 172 次远多于 pwsh 31 次 —— 这是
  「bash 里更常写 `node -e` / `python -c` 这种内联程序」的构造成本差异，不是 shell 的语法问题。
  结论：**两者都不常输错命令；pwsh 略高的一点全部来自「把 JS/引号塞进 PowerShell 的 `-Command`」，
  这是 PowerShell 引号规则的固有成本，不是模型手滑。**
- **耗时**：模型生成占一步耗时的 **91.8%**（吞吐 ~237 tok/s 恒定，没有每步固定开销）；
  推理文本占输出字符的 **69.6%**、工具参数 28.2%、可见正文 2.2%；
  前缀缓存命中 **96.7%**；重复工具调用仅 3.5%。
  工具侧则相反地便宜：持久 Git Bash 每次 40–93 ms，而持久 pwsh7 650–900 ms（~35×），
  一次性 PS 5.1 ~2096 ms。一次实测会话说 43 次 pwsh 调用 p50 675 ms、合计 78.2 s。

## 运行方式

```powershell
python shell-grammar-final.py C:\Users\rain\.dsh\sessions
node   shell-error-audit.mjs C:\Users\rain\.dsh\sessions
```

- Python 侧需要 `zstandard`；**必须用 `stream_reader`**——
  `ZstdDecompressor().decompress()` 直接调用会报
  `ZstdError: could not determine content size in frame header`。
- 全脚本只读，输出走 stdout。
- 这些脚本里写的是**宿主机上的绝对会话路径**，换机器要改 argv 或常量。
