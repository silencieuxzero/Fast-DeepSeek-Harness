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

## 结论（作为快速模式立项依据的那三组数）

- **shell 语法错误率**：pwsh 43/1456 = **2.95%** vs bash 4/275 = **1.45%**。
  但 bash 那 4 次按 stderr 判定**全是假阳性**（一个审计脚本本身在打印捕获到的 PowerShell 错误文本），
  所以 bash 的真实自伤率 ≈ **0%**。
- **归因到模型自己写错**：pwsh 36 次 = **2.5%**、bash 2 次 = **0.7%**。
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
