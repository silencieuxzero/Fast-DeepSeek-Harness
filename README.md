# 快速模式（`bash-first`）预设 — 相关文件归档

本仓库（原工作区目录 `fast-mode-preset\`）把「快速模式」这个预设的全部相关文件集中归档，
作为一份**只读归档 + 复原素材**。
真正生效的文件仍是宿主 profile 目录 `C:\Users\rain\.dsh\profiles\desktop\` 下的那几个；
这里的是它的副本、生成器、验证脚本与说明文档。

仓库根目录布局：`README.md` + `profile/`（宿主文件副本）+ `tools/`（生成器与校验脚本）+ `analysis/`（测量脚本）+ `experiment/`（A/B 实验）+ `docs/`（说明文档）。

## 这个预设是什么

- **预设 id**：`bash-first`；**显示名**：快速模式；**roster 行 id**：`preset-bash-first`；order 5。
  显示名从 `Bash First` 改成 `快速模式` 时，id 刻意保持不变，已有会话与文档引用不会断。
- **行为**：该预设下模型默认只看得见 `bash`，`pwsh` 的 schema 被真的从工具面移除（不是提示词劝告）；
  bash **连续失败 2 次**后解除限制，注入一条 `tool-addition` 开发者消息，并在系统提示挂上
  `## PowerShell fallback unlocked`。解锁是**单向**的——一次侥幸成功不会把 pwsh 再藏回去，
  避免工具面反复横跳作废前缀缓存。
- **能力面**：= 标准模式（standard）的全部能力（33 个成员零丢失）+ 创造模式（`cordis` 预设）独有的三项：
  `tool-cordis` 行、`skill-filesystem` 的 `customSkillDirs`（三个 Cordis 编写技能）、
  `tool-plugin-manager` 解禁 + PTC 模式独有的 `tool-presentation` 行（`mode: both`）。
- **PTC（程序化工具调用）**：`tool-presentation` 一行把 `mode` 设为 `both` —— 模型既可以直接调
  `bash` 等原生工具，也可以调 `run_code` 在一个程序里 `await tools.bash(...)`，只读调用还能 `Promise.all`
  重叠，中间结果不进对话。**刻意不用纯 `ptc`**：那会让 `bash` 的 schema 从请求里消失，与上面
  「模型只看得见 bash」的门控叙事、以及 shell-fallback 注入的 10155 提示词直接矛盾。
  该行要求已组合 `ctx.ptcRuntime`（本机 `include:ptc-runtime` 行 active）+ 已注册 SDK 渲染器，
  缺任一则**整个预设**在挂载时被拒（不会降级成 native）。
  与创造模式不同，本预设**不禁用** `workflow-ptc` / `tool-workflow`（本机 runtime 是 TypeScript，
  `workflow` 的 output schema 实测 lossless，不会触发 `sdkSchemas()` 守卫）；未来若换成 Python PTC
  provider，这三行（含 `tool-ralph`）必须一起禁用。

## 目录内容

| 路径 | 对应宿主/原位置 | 说明 |
| --- | --- | --- |
| `profile/shell-fallback.mjs` | `C:\Users\rain\.dsh\profiles\desktop\shell-fallback.mjs` | 门控插件本体（11,191 B）。`tools.restrict({deny:['pwsh']})` + 失败计数 + 单向解除 |
| `profile/live-cordis.patch.yml` | `C:\Users\rain\.dsh\profiles\desktop\cordis.patch.yml` | **当前生效**的完整 profile patch（35,332 B，702 行；已去除 fast-dsh 残留，并已删除 `reasoning-budget` 行）。`:436` 是**唯一**的 `- insert:`，`:437` 是 `preset-bash-first`；`:520` 是 preset 内部 `shell-fallback` 成员行；`:648` 是 `tool-presentation`（`mode: both`）；`:658` 是顶层 `agent-preset-registry`；`:89-100` 是已删 `reasoning-budget` 行的留痕注释（含恢复用的注释块） |
| `profile/cordis.patch.yml.bak-before-ptc-both` | 同名前缀文件 | 装上 PTC（`mode: both`）之前的备份（34,379 B，690 行），**回滚用** |
| `profile/cordis.patch.yml.bak-before-rb-removal` | 同名前缀文件 | 删除全局 `reasoning-budget` 行之前的备份（35,002 B，699 行），**回滚用** |
| `profile/cordis.patch.yml.bak-before-bash-first` | 同名前缀文件 | 追加 bash-first 之前的备份（22,219 B），**回滚用** |
| `profile/cordis.patch.yml.bak-before-cordis-caps` | 同名前缀文件 | 并入创造模式能力之前的备份（35,011 B） |
| `tools/gen-bash-first-preset.mjs` | 本目录 | 从 live patch 幂等重生成预设块（切片而非重打，`!!js`/折行/缩进无法手抄）。步骤 3b 并入创造模式三项，步骤 3c 插入 `tool-presentation`（`mode: both`） |
| `tools/splice-bash-first.mjs` | 本目录 | 把生成块写回 live patch，**只替换末尾那段 `- insert:`**，并原样搬运其后的顶层 `agent-preset-registry` 行 |
| `tools/verify-bash-first-compose.mjs` | 本目录 | 离线复核组合结果（门控 5 项 + 创造模式能力 + PTC 呈现行，共 20 项断言） |
| `tools/test-shell-fallback.mjs` | 本目录 | 门控单测，36 项 |
| `tools/check-live.mjs` | 本目录 | 用真实分层重放 live 组合 |
| `tools/bash-e2e-correct.mjs` | 本目录 | PTY 端到端计时（空闲阈值实测） |
| `tools/bash-truncation-safety.mjs` | 本目录 | 静默/大输出截断安全性验证 |
| `tools/gen-preset-standard-override.mjs` | 本目录 | 生成 `preset-standard` 覆盖块的原始脚本 |
| `tools/verify-profile-patch.mjs` | 本目录 | profile patch 结构校验 |
| `analysis/` | 本目录 | 当初量出「该不该做 bash-first」的分析脚本（shell 失败率 / 失败成因 / 耗时去向），只读会话记录；见 `analysis/README.md` |
| `experiment/` | 本目录 | 「压缩推理预算提示词能否省推理」的 A/B 实验：两臂插件、固定被试任务、统计脚本与原始数据。**结论为阴性**；见 `experiment/README.md` |
| `docs/bash-first-预设说明.md` | `C:\Users\rain\Documents\deepseek-harness\默认工作区\` | 安装/机制细节说明（踩坑、验证记录） |

## 重新生成并写回（PowerShell）

```powershell
cd "<本目录>\tools"
node gen-bash-first-preset.mjs C:\Users\rain\.dsh\profiles\desktop\cordis.patch.yml $env:TEMP\bf.yml
node splice-bash-first.mjs   C:\Users\rain\.dsh\profiles\desktop\cordis.patch.yml $env:TEMP\bf.yml
node verify-bash-first-compose.mjs $env:TEMP\bf.yml
```

## 三条必须记住的运维约束

1. **`splice-bash-first.mjs` 不能省，也不能换成「找第一个 `- insert:`」。**
   该 patch 里**曾经**有两处 `- insert:`（`:92` 是 bundle 层的、`:433` 才是预设块）。
   **2026-10-03 删除 `reasoning-budget` 后只剩一处**（`:436`），但脚本仍必须以
   `    - id: preset-bash-first` 为锚点向上找最近的 `- insert:`，不要图省事改成「找第一个」——
   将来 bundle 层再插一行就会重演旧事故。
   直接找第一个会把 350 KB 的 patch 砍成 16 KB（已踩过一次，靠 `bak-before-cordis-caps` 恢复）。
   脚本以 `    - id: preset-bash-first` 为锚点向上找最近的 `- insert:`，保证只替换末尾那段。
2. **顶层 `agent-preset-registry` 行不归生成器管，splice 必须原样搬运。**
   它的位置很反直觉——在**生成的 member 之后、banner 之前**（live patch `:658-664`）：

   ```yaml
   - id: agent-preset-registry
     name: "@deepseek-ai/dsh-agent-preset-registry"
     config:
       default: standard
       selectedDefault: bash-first
   ```

   它是 `- insert:` 的**兄弟顶层条目**，不是生成块的成员，而它正是「快速模式」被选为默认预设的原因。
   早期版本的 splice 写的是「从 `- insert:` 一路替换到 EOF」，于是把它整段删掉（实测 `653,657d652`，
   表现为预设默认值悄悄回退）。现在脚本把「member 结束 → banner 开始」之间的行原样搬运，
   再用生成器的新 member + 新 banner 夹住它。另外 `head.join('\n')` 必须补回换行，
   否则会粘成 `disabled: true- insert:` 这一行废掉整个 YAML。
3. **改 `shell-fallback.mjs` 必须递增挂载行的 `?v=N`。**
   `cordis-plugin-loader/lib/index.js:219-222` 用 `await import(new URL(name, baseUrl).href)`，
   Node 按 URL 缓存 ESM ⇒ 进程内改插件文件不生效（loader 的 `internal/update` 只热更 config）。
   当前挂载写法是 `name: ./shell-fallback.mjs?v=2`；生成器里已写死 `?v=2`，
   所以手工在 live patch 上加的版本号一旦重新生成就会被抹掉。

## 回滚

**只撤 PTC（保留快速模式）**：覆盖 `cordis.patch.yml.bak-before-ptc-both`（690 行，装 PTC 前状态），开新会话。

**整个撤掉快速模式**：删掉生成的整段块（`live-cordis.patch.yml` 里从 `# PRESET: bash-first` 横幅到文件末尾，
注意**保留**横幅之前的顶层 `agent-preset-registry` 行）外加 `shell-fallback.mjs`，然后**开新会话**；
`cordis.patch.yml.bak-before-bash-first` 就是追加前状态，可直接覆盖回去。

**恢复全局 `reasoning-budget` 段落**（2026-10-03 已删除）：该行原本是 patch 里**第一处** `- insert:`
（bundle 层），填回 `live-cordis.patch.yml:89-100` 的注释块位置即可，原文见
`experiment/arms/reasoning-budget.removed.mjs`（插件本体，75 行 / 4,268 B，需复制回
`C:\Users\rain\.dsh\profiles\desktop\reasoning-budget.mjs`）。删它的依据是 `experiment/REPORT.md`
——A/B 结论为**阴性**（推理字符/步 B/A = 0.975，CI 0.73–1.31，无端点显著）。

**删除时的完整备份**：`cordis.patch.yml.bak-before-rb-removal`（35,002 B，699 行）是删除前状态，
已一并归档在 `profile/` 下。

## 归档副本的注意点

- `tools/test-shell-fallback.mjs` 里写的是**绝对路径**
  `file:///C:/Users/rain/.dsh/profiles/desktop/shell-fallback.mjs`，
  即它测的始终是宿主里那份本体，不是 `profile/` 下这份副本。
- `verify-bash-first-compose.mjs` / `check-live.mjs` 同样用绝对路径 `createRequire`
  到 `C:/Users/rain/.dsh/profiles/node_modules/dsh-desktop-next/` 取 `yaml` 与
  `cordis-plugin-include`，因此要在装有 DSH 的这台机器上跑。
- 本目录文件均为**逐字节副本**（已 `cmp` 校验），未做任何改写。
- **2026-10-03 fast-dsh 清除**：`live-cordis.patch.yml` 已同步为去除 fast-dsh 残留后的版本
  （原 41 行 "INERT DOCUMENTATION ONLY" 注释块被精简，4 处注释里的 `E:\fast-dsh\tools\...`
  路径改写为 `<repo>\tools\...`）；解析出的 YAML 结构与清除前**完全一致**，
  预设与 `selectedDefault: bash-first` 未受影响。原始版本见 `C:\Users\rain\.dsh\profiles\desktop\cordis.patch.yml.bak-before-fastdsh-purge`。
