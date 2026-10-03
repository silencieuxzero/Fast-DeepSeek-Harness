# bash-first 预设：bash 专属，PowerShell 仅作兜底

创建于 2026-10-03。目标（用户原话）：*「能否你自己创建一个预设，这个预设下只调用 bash，
powershell 作为备用手段（如 bash 命令调用失败若干次后）」*。

## 它做什么

新预设 `bash-first`（显示名 **快速模式**，roster order 5 —— 预设 id 仍是 `bash-first`，
只有 GUI 里显示的名字改了）。

- 模型默认**只能看到 `bash`**；`pwsh` 的 schema 被真的从工具面里移除，不是提示词劝告。
- bash 连续失败 **2** 次后，`pwsh` 被解除限制并注入一条 `tool-addition` 开发者消息，
  系统提示同时挂上 `## PowerShell fallback unlocked` 段。
- 解锁是**单向**的：一次侥幸成功不会把 pwsh 再藏回去（工具面反复横跳会作废前缀缓存）。

## 能力面：标准模式 + 创造模式

本预设 = **standard 的全部能力**（33 个成员零丢失）+ **创造模式（`cordis` 预设）独有的三项**。
逐行 diff 两份出厂定义（`dsh-web-app/presets/{standard,cordis}.patch.yml`）后确认差异**只有三处**，
已全部并入：

| 并入项 | 效果 |
| --- | --- |
| `tool-cordis` 行 | 解锁 `cordis_inspect_list` / `cordis_inspect_query`（运行时检查） |
| `skill-filesystem.config.customSkillDirs` | 编入 `dsh-agent-preset` 自带的三个 Cordis 编写技能 |
| `tool-plugin-manager` 解禁 | 从 `disabled: true` 改为 `!!js "!ctx.get('profileContext')"` |

三项技能：`cordis-composition-reference`、`cordis-plugin-development`、`editing-cordis-compositions`。

**注意 `customSkillDirs` 不能照抄出厂写法。** 出厂 cordis 预设用
`createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')`，那份配
置于 web-app 的 `presets/` 目录下求值，能解析到；而**本 patch 的 baseUrl 是 profile 目录**，
同一调用实测抛 `MODULE_NOT_FOUND`。所以本预设改为从 profile 上溯到
`../node_modules/dsh-desktop-next/package.json` 再解析 —— `dsh-desktop-next` 是指向 DSH 安装
目录的 junction，那个基准下 `createRequire` 可用，实测解析出 `.../dsh-agent-preset/skills`
且三个技能都在。

`tool-cordis` 不需要额外挂载：`dsh-web-app/cordis.patch.yml:144-151` 已在 **bundle 级**挂了
`cordis-host-runner` 与 `cordis-inspect-providers`，注释写明「inspect providers 是进程全局的，
注册一次，每个预设的 `tool-cordis` 行都读它们」。预设行只是开关。

## 「失败」怎么算（关键设计点）

持久 bash 工具**不会**在非零退出时抛错：`pbash.js` 的 `renderCaptured()` 把
`[Command finished with exit code N]` 追加到**成功**结果里。所以只看 `result.isError` 会漏。

但普通非零退出**不算** shell 失败，默认不计入：`grep` 无匹配、`git diff --quiet`、
`test -f` 都是以非零退出作为**正常的正确答案**；计进去会让两条日常命令就把 pwsh 放出来，
彻底毁掉「bash 专属」这个前提。

默认计数的是 **shell 本身坏掉**：

| 计入 | 判据 |
| --- | --- |
| ✅ | `result.isError === true` |
| ✅ | `[Command timed out or OOM]` |
| ✅ | `[shell exited: code N]` / `[shell exited]` / `[shell killed by signal: X]` |
| ✅ | `The persistent bash shell was reset…`（状态丢失） |
| ❌ | `[Command finished with exit code N]`（N≠0）—— 默认不计 |

注意 `exit 3` 在持久 shell 里产生 `[shell exited: code 3]`，即**它结束的是 shell 本身**，
所以算失败。

若想要更宽松的「bash 不好使了就放 pwsh」，把门控配置加上 `countCommandFailures: true`。

## 文件与挂载

| 文件 | 作用 |
| --- | --- |
| `C:\Users\rain\.dsh\profiles\desktop\shell-fallback.mjs` | 门控插件本体（256 行） |
| `C:\Users\rain\.dsh\profiles\desktop\cordis.patch.yml:437` | `preset-bash-first` 声明块（250 行） |
| `C:\Users\rain\.dsh\profiles\desktop\cordis.patch.yml:520` | `shell-fallback` 成员行（**在 preset 的 `plugins` 内部**） |
| `<workspace>\fast-mode-preset\tools\gen-bash-first-preset.mjs` | 从 live patch 重新生成预设块（幂等） |
| `<workspace>\fast-mode-preset\tools\splice-bash-first.mjs` | 把生成块写回 live patch（只替换末尾那段 `- insert:`；现只剩 `:436` 一处，但脚本仍按锚点定位） |
| `<workspace>\fast-mode-preset\tools\verify-bash-first-compose.mjs` | 离线复核组合结果 |
| `<workspace>\fast-mode-preset\tools\test-shell-fallback.mjs` | 门控单测（36 项） |
| `<workspace>\fast-mode-preset\tools\check-live.mjs` | 用真实分层重放 live 组合 |

**门控行必须在 preset 自己的 `plugins` 里，不能在 profile 顶层。** profile 顶层行会连
`standard` 预设一起命中 —— standard 同样同时暴露 bash 与 pwsh（Windows 上是一次性
`tool-pwsh`），门控的自门控条件成立，就会悄悄改掉用户没要求改的预设。作为 preset 成员时
靠作用域父子自动限定（`apr.js:678 bindScopeParent`）。

## 两个必须记住的坑

**1. 改插件模块后必须换 URL 或重启宿主。** loader 用
`await import(new URL(name, this.ctx.baseUrl).href)`（`cordis-plugin-loader/lib/index.js:219-222`），
Node 按 URL 缓存 ESM，进程内改文件**不生效**；loader 的 `internal/update` 只热更 config。
所以行里写的是 `name: ./shell-fallback.mjs?v=2`。**下次改完这个文件要把 `?v=2` 递增。**
（这一条是实测踩出来的：11:52:14 落盘的修正，在 11:52:45 启动的探针里跑的仍是旧语义。）

**2. `shell-fallback` 与 `terminal` 后端的 `backendType` 冲突。** bash 与 pwsh 两个 PTY 后端
都默认 `backendType: "shell"`，同时注册会抛 `DUPLICATE_BACKEND` 让整组 mount 失败。
本预设给两个 pwsh 成员显式写了 `backendType: shell-pwsh`，`terminal-bash` 保持默认。

## 怎么用 / 怎么撤

在 GUI 的 Agent 选择器里选 **快速模式**（预设 id `bash-first`）。预设是**启动时**绑定的，
已有会话保持它启动时的 revision —— 必须**新开会话**才生效。

撤销：

```powershell
# 1. 删掉 cordis.patch.yml 里 436 行起的整块（`- insert:` 到文件末尾的注释区之前）
#    或直接从备份恢复：
Copy-Item C:\Users\rain\.dsh\profiles\desktop\cordis.patch.yml.bak-before-bash-first `
          C:\Users\rain\.dsh\profiles\desktop\cordis.patch.yml -Force
# 2. 删除门控插件
Remove-Item C:\Users\rain\.dsh\profiles\desktop\shell-fallback.mjs
```

门控本身是作用域化的、卸载即回卷：限制是 `agent.ctx.effect()`
的 disposer，prompt section 由 `systemPrompt.section()` 返回，它不持有任何其它状态。

## 验证记录

- `verify-bash-first-compose.mjs` → all checks passed（20 个 preset 成员、standard 成员零丢失、
  pwsh 对 `disabled="process.platform !== 'win32'"` + `backendType="shell-pwsh"`、
  门控**不在** standard 里）。
- `test-shell-fallback.mjs` → **36/36 passed**（含「grep 无匹配不计」「kill -9 计入」
  「flaky 失败永不解锁」等边界）。
- 实机探针（preset `bash-first`，会话 `session-0add6932-…`）：
  - 首个请求 `tools=75 hasPwsh=false`；
  - `false` ×2（普通非零退出）→ **没有**解锁 ✅ 严格语义生效；
  - `kill -9 $$` ×2（shell 死亡）→ `REQ#2 tools=76 hasPwsh=true`，
    伴 `tool-addition pwsh` 与 `## PowerShell fallback unlocked` ✅
- 反向对照（preset `standard`）：`pwsh=ABSENT bash=PRESENT unlock_section=ABSENT`，
  确认门控没有泄漏到别的预设。
- 创造模式能力探针（preset `bash-first`，会话 `session-a70aac8d-…`，`succeeded`）：
  `cordis_list=YES cordis_query=YES plugin_mgr=YES pwsh=ABSENT`，技能表里含
  `cordis-composition-reference`、`cordis-plugin-development`、`editing-cordis-compositions`；
  该请求 `toolCount=78`（75 + 2 个 cordis 检查工具 + 1 个 `plugin_manager`）✅
