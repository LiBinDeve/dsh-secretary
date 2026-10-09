# Secretary / 秘书

为 DeepSeek Harness 提供秘书 Agent 预设，让用户通过一个对话管理多个项目和独立任务会话。

这是首个公开版本，版本号沿用现有的 `1.0.0`。功能仍在实际使用中迭代。

## 功能

- 创建项目目录，并登记为 Harness Workspace。
- 列出已登记的项目及会话数量。
- 在项目中开启独立 Session，交代完整任务。
- 查询会话日志中的状态和最近消息。
- 向已有会话追加指令。

秘书通过已有的 `workspaceRegistry`、`sessionController` 和 `sessionQuery` 服务工作，工具通过 `tools` 服务注册。`cordis.patch.yml` 把秘书工具、persona 和其他能力组合成秘书预设。

## 安装和使用

公开仓库为 `LiBinDeve/dsh-secretary`。可安装到已有的 Web profile：

```powershell
dsh plugin --profile web add github:LiBinDeve/dsh-secretary
```

当前发布副本也可以从本地目录安装：

```powershell
dsh plugin --profile web add ./secretary
```

从包含 `secretary` 目录的父目录执行此命令。需要 DeepSeek Harness CLI、pnpm，以及已配置可用模型的 Web 环境。

安装后，在新建会话时选择“秘书”Agent 预设。为秘书选择适当的工作目录；默认会把新项目目录建在该目录下面。

可以这样提出任务：

> 创建一个名为 demo-project 的项目，在里面开一个线程，写一个展示项目介绍的页面。先把目标和验收标准完整交代给新线程。

随后继续询问进展，或要求秘书向该线程追加指令。新线程是独立会话，无法直接看到秘书当前的对话。

## 工具

| 工具 | 用途 |
| --- | --- |
| `secretary_list_projects` | 列出已注册项目 |
| `secretary_create_project` | 创建并注册项目 |
| `secretary_list_threads` | 列出指定项目的会话，最多返回 40 个 |
| `secretary_create_thread` | 创建会话并发送首次任务 |
| `secretary_send_to_thread` | 向已有会话追加指令 |
| `secretary_read_thread` | 读取日志状态和最近消息，默认 8 条，最多 50 条 |

## 首版行为与已知限制

- 进展由日志推断，可能与实时运行状态不一致；历史失败信息可能在新回合开始后仍然返回。
- 创建会话后发送任务失败，可能留下已创建的会话。重试前应先列出项目会话，避免重复创建。
- 查询工具按需执行。此实现没有提供自动轮询和任务完成自动通知。
- 项目列表包含服务中的全部注册项目，并非仅秘书创建的项目。
- 目录检查不构成系统级沙箱保证；符号链接、Windows junction、保留名称和磁盘根目录等情况尚待完善。
- 每条返回消息最长 1200 个 JavaScript 字符单位，超出部分截断；读取时仍会加载完整会话日志。
- 新任务会话使用部署默认预设。用户仍可在 Harness 中查看这些会话；persona 中“只有秘书能看”的文字不是访问控制机制。
- 卸载插件不会删除已经创建的项目目录和会话记录。

首版尚未完成干净环境中的完整安装和模型调用验证。请在使用中提交可复现的问题，后续版本逐步修正。

## 开发

项目采用原生 JavaScript ESM，不需要编译。当前包声明 `private: true`，用于本地或 Git 源分发；该配置禁止发布 npm。

文件结构：

```text
index.js             六个工具和辅助函数
cordis.patch.yml     秘书 Agent 预设配置
package.json         模块入口和组合包声明
locale/              中英文插件介绍
icon.svg             插件图标
```

未来版本将沿着真实使用反馈改进任务恢复、进展状态、目录处理和安装兼容性。

## English

Secretary adds an agent preset for DeepSeek Harness to create projects, start independent task sessions, read recent progress, and send follow-up instructions through one conversation. This initial release is an early preview. Progress is queried on demand and inferred from session logs; automatic monitoring and completion notifications are not implemented by this plugin.
