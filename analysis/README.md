# analysis/ — pwsh vs bash「输错命令」定稿口径

回答的问题（用户原话，会话 m00832）：「dsh 在 PowerShell 下经常输错命令，bash 是不是也有同样的问题？」

三个脚本按时间顺序迭代出**定稿口径**（final），全部只读，解析 `C:/Users/rain/.dsh/sessions/`
下的会话记录（`.jsonl.zstd` 用 zstandard `stream_reader`，`tool/call` 按 `callId` 配对 `tool/result`）。

## 三个脚本

| 脚本 | 口径 | 用途 |
|---|---|---|
| `mistype-strict.py` | 只统计「shell 本身拒绝命令文本」的失败：shell 的原生报错出现在 `[stderr]` 区，或无该标记时落在非零退出码的记录里。显式排除：合法命令但路径不存在/grep 无命中/缺二进制/超时、内嵌程序（`node -e`、`python -c`）自身的 bug、程序**打印**的错误字符串（审计脚本回显报错文本不算失败） | 严格口径的 pwsh vs bash 失败率 |
| `mistype-conditional.py` | 条件化对比：风险不是均匀分布的——几乎所有的 shell 拒绝都发生在内嵌程序或带引号路径的命令里。核对混杂：会话是否两把 shell 混用（会话内对比）、每把 shell 内嵌程序占比、同构命令下的拒绝率、两个语料的年代/工作类型 | 排除「pwsh 会话恰好更多复杂命令」的混杂 |
| `mistype-final.py` | 把失败显式分成两类：**A. shell-grammar**（shell 拒绝命令文本 = 「输错命令」）与 **B. program-bug**（命令解析成功但内嵌程序有 bug） | 定稿口径，报告分母、分子与两类分别的速率 |

## 复现

```bash
cd fast-mode-preset/analysis
python mistype-final.py          # 定稿数字
python mistype-conditional.py    # 混杂核对
```

原始shell 审计系列（`shell-error-audit.py` / `shell-grammar-*.py` / `step-timing.py`，2026-10-03 清理时
已删除）：与这三个脚本口径重叠，结论已并入 README 正文，方法可由本 README + mistype-*.py 复原。
