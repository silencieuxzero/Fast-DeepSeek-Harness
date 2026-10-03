# `profile/history/` — 宿主 profile 目录的历史备份归档

这里放的是宿主 profile 目录 `C:\Users\rain\.dsh\profiles\desktop\` 下**曾经**躺着的历史备份文件
（`cordis.patch.yml.bak-*`、`package.json.bak-*`、`pnpm-workspace.yaml.bak`）。
它们是每一步改动前的快照，改动已被 `profile/live-cordis.patch.yml` 与后续提交取代，
因此于 2026-10-03 从宿主移到这里：**保留可复原素材，但不再污染宿主目录**。

均为**逐字节副本**（`cmp` 已校验），未做任何改写。回滚时把它们复制回原位即可。

| 文件 | 字节 / 行 | 是什么改动之前的快照 |
| --- | --- | --- |
| `cordis.patch.yml.bak-t4` | 2,975 / 97 | 最早的一份手改补丁（`t4` 时期），只有几行 bundle 层覆盖 |
| `cordis.patch.yml.bak-before-persistent-pwsh` | 5,990 / 153 | 把 pwsh 从一次性调用改成**持久会话**之前 |
| `cordis.patch.yml.bak-before-idle-tuning` | 17,397 / 380 | 调持久 shell 的 idle / 静默阈值之前 |
| `cordis.patch.yml.bak-before-bash-default` | 18,685 / 401 | 把默认 shell 换成 bash 之前（**改回 PowerShell 的参照物**） |
| `cordis.patch.yml.bak-before-bash-first` | 22,219 / 451 | 追加「快速模式」整段预设之前 |
| `cordis.patch.yml.bak-before-cordis-caps` | 35,011 / 697 | 把创造模式三项能力并进快速模式之前 |
| `cordis.patch.yml.bak-before-path-reword` | 34,467 / 690 | 改写注释里的路径引用之前 |
| `cordis.patch.yml.bak-before-desc-cn` | 35,669 / 709 | 把预设显示名 / 描述改成中文之前 |
| `cordis.patch.yml.bak-before-fastdsh-purge` | 35,665 / 709 | 清除已弃用插件 `fast-dsh` 残留之前。**与原版 `live-cordis.patch.yml` 差异仅在注释**，解析出的 YAML 结构完全一致 |
| `cordis.patch.yml.bak-before-ptc-both` | 34,379 / 690 | 装上 PTC 呈现行（`mode: both`）之前 |
| `cordis.patch.yml.bak-before-rb-removal` | 35,002 / 699 | 删除全局 `reasoning-budget` 段落之前 |
| `package.json.bak-extensionfail` | 916 / 33 | 一次扩展加载失败时的 `package.json`。与在用的差异：少了 `"version": "0.0.0"`，多了一行已删的 `"@local/fast-deepseek-harness": "link:E:/fast-dsh/plugins/fast-deepseek-harness"` |
| `pnpm-workspace.yaml.bak` | 234 / 13 | 与在用的差异仅在 `minimumReleaseAgeExclude` 的写法（已改成 `'billion-context@0.1.178 \|\| 0.1.179 \|\| 0.1.180'` 一行） |

## 已在 `profile/` 下的四个

`profile/` 根下另有 4 个早就归档过的 `cordis.patch.yml.bak-before-*`（`bash-first` / `cordis-caps` /
`ptc-both` / `rb-removal`），它们与这里的同名文件**是同一份内容**（md5 一致），保留在原位不动，
因为仓库根 `README.md` 的回滚说明直接引用那几个路径。

## 注意

- 删除宿主备份后，宿主 `cordis.patch.yml:182` 那条
  `# REVERT to PowerShell: restore cordis.patch.yml.bak-before-bash-default, or set ...`
  注释里的文件名已指向本目录（注释已同步改写）。
- 这些文件是**宿主专属**的：它们记录的是这台机器上 profile 目录的演化，不含任何密钥，
  但 `package.json.bak-extensionfail` 里带本机绝对路径。
