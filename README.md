# WeChat Channel for Claude Code

[English](./README.en.md)

通过 [MCP 通道协议](https://code.claude.com/docs/en/channels)，将你的个人微信消息桥接到 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)。

在手机微信里发一条消息，Claude Code 就能收到、处理并回复——直接回到你的微信聊天中。

## 工作原理

```
┌──────────┐       ilink bot API       ┌─────────────┐      MCP stdio      ┌────────────┐
│   微信   │ ◄──────────────────────── │ channel.mjs │ ◄────────────────── │ Claude Code│
│   App    │ ──────────────────────►   │ (MCP 服务器) │ ──────────────────► │            │
└──────────┘   长轮询 / 发送消息        └─────────────┘   通知 + 回复工具     └────────────┘
    手机          ilinkai.weixin.qq.com    你的电脑                             终端
```

1. 用微信扫描二维码，关联你的账号
2. 通道持续长轮询微信的 ilink bot API 获取新消息
3. 收到的消息以 MCP 通道通知的形式转发给 Claude Code
4. Claude Code 通过 `reply` 工具回复，消息发回你的微信

本项目使用微信官方的 **ilink bot 协议**——与腾讯官方的 [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) 插件使用的协议完全相同。

---

## 前置要求

| 要求 | 说明 |
|---|---|
| **Node.js >= 22** | 需要原生 `fetch` 支持 |
| **Claude Code >= v2.1.80** | 通道功能支持（研究预览阶段） |
| **通过 claude.ai 登录 Claude Code** | 通道功能需要 claude.ai 认证，不支持 API key |
| **一个微信账号** | 个人微信（不是企业微信） |

---

## 安装

### 方式 A：快速安装（推荐）

```bash
git clone https://github.com/user/wechat-claude-code-channel.git
cd wechat-claude-code-channel
./setup.sh
```

安装脚本会自动：
- 检查 Node.js >= 22
- 执行 `npm install`
- 检测你的 `node` 二进制路径
- 生成包含正确绝对路径的 `.mcp.json` 配置文件

### 方式 B：手动安装

```bash
git clone https://github.com/user/wechat-claude-code-channel.git
cd wechat-claude-code-channel
npm install
```

在项目目录下创建 `.mcp.json` 文件：

```json
{
  "mcpServers": {
    "wechat": {
      "command": "node",
      "args": ["/你的绝对路径/wechat-claude-code-channel/channel.mjs"]
    }
  }
}
```

> **nvm 用户注意：** `"command"` 必须是 Node.js 二进制的完整路径，因为 Claude Code 以子进程方式启动通道，不会加载你的 shell 配置。用 `which node` 查找路径，例如 `"/Users/你的用户名/.nvm/versions/node/v22.22.1/bin/node"`。

---

## 使用方法

### 第一步：启动带微信通道的 Claude Code

```bash
cd /path/to/wechat-claude-code-channel
claude --dangerously-load-development-channels server:wechat
```

> `--dangerously-load-development-channels` 标志在通道研究预览阶段是必需的，它告诉 Claude Code 加载本地 `.mcp.json` 中定义的自定义通道。

### 第二步：微信扫码登录

首次启动时，通道没有保存的凭据。Claude Code 会自动调用 `wechat_login` 工具，直接在对话中返回一个 **ASCII 二维码**：

```
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
█ ▄▄▄▄▄ █▄▄██████▄▀▀▄██▄  ▀▄█▀█ ▄▄▄▄▄ █
█ █   █ █ ▀█ ▄ ▄▀ ▀██ ██▄▄▄ ▄██ █   █ █
█ █▄▄▄█ █▄ ▄▄▀ ▀▄▄▄▀  █▄█▀█ ▄██ █▄▄▄█ █
...
```

**打开微信 → 发现 → 扫一扫**（或点击右上角 `+` → 扫一扫），扫描终端中的二维码。

扫描后，在手机上确认登录。Claude Code 中会显示通知：

```
WeChat login successful! Bot connected.
```

凭据保存在 `~/.claude/wechat-channel/credentials.json`，后续启动会自动复用——只需扫码一次。

### 第三步：从微信发消息

连接成功后，**在微信中发送任意文字消息**给机器人。消息会出现在你的 Claude Code 会话中，Claude 可以回复到你的微信聊天。

使用示例：

1. 你在微信中发送「我当前 git 仓库里有什么？」
2. Claude Code 通过通道收到消息
3. Claude 执行 `git log`、读取文件等操作
4. Claude 调用 `reply` 工具把结果发回你的微信

### 第四步：持续聊天

只要 Claude Code 在运行，通道就保持连接。你可以在微信和 Claude Code 之间来回发送多条消息。

---

## 工具

通道向 Claude Code 暴露三个工具：

### `reply`

向微信用户发送回复消息。

| 参数 | 类型 | 说明 |
|---|---|---|
| `to` | string | 微信用户 ID（来自收到的通道消息的 `from` 属性） |
| `text` | string | 要发送的消息文本 |

超过 4000 字符的消息会自动拆分为多条发送。

### `wechat_login`

发起新的二维码登录。立即返回 ASCII 二维码，后台轮询等待扫描，并在状态变化时发送通知（已扫描、已确认、已过期）。

用途：
- 首次连接
- 会话过期后重新连接

### `wechat_allow`

将微信用户 ID 添加到白名单。

| 参数 | 类型 | 说明 |
|---|---|---|
| `user_id` | string | 要允许的微信用户 ID |

默认情况下，扫描登录二维码的用户会自动添加到白名单。其他用户需要手动添加。

---

## 安全与白名单

只有**白名单中的用户**发送的消息才会转发给 Claude Code。这可以防止其他微信用户向你的编程会话注入消息。

- 扫描二维码的用户会**自动加入白名单**
- 可以通过 `wechat_allow` 工具或直接编辑 `~/.claude/wechat-channel/allowlist.json` 添加更多用户
- 如果白名单为空（文件不存在或为 `[]`），**所有消息**都会被转发（不推荐）

---

## 文件位置

所有状态都存储在**项目目录之外**，避免敏感信息被意外提交：

```
~/.claude/wechat-channel/
├── credentials.json   # 机器人 token + bot ID（权限 600）
├── sync-buf.txt       # 消息同步的长轮询游标
└── allowlist.json     # 允许的发送者用户 ID 列表
```

项目目录只包含源代码和 `node_modules`。生成的 `.mcp.json`（包含你的本地路径）已在 `.gitignore` 中。

---

## 架构

本通道是一个单文件 [MCP](https://modelcontextprotocol.io/) 服务器（`channel.mjs`），它：

1. **声明** `claude/channel` 能力，使 Claude Code 将其视为通道
2. **通过 stdio 传输连接**（Claude Code 将其作为子进程启动）
3. **通过二维码登录**微信（ilink bot 协议）
4. **长轮询** `ilinkai.weixin.qq.com/ilink/bot/getupdates` 获取新消息
5. **推送**消息给 Claude Code，作为 `notifications/claude/channel` 事件
6. **暴露** `reply` 工具，使 Claude Code 可以发送消息回微信

### 协议详情

| 操作 | 端点 | 方法 |
|---|---|---|
| 获取二维码 | `ilink/bot/get_bot_qrcode?bot_type=3` | GET |
| 轮询二维码状态 | `ilink/bot/get_qrcode_status?qrcode=...` | GET（长轮询） |
| 获取消息 | `ilink/bot/getupdates` | POST（长轮询） |
| 发送消息 | `ilink/bot/sendmessage` | POST |

所有 API 请求使用二维码登录时获取的 `Authorization: Bearer <token>` 认证。

### 依赖

| 包 | 用途 |
|---|---|
| `@modelcontextprotocol/sdk` | MCP 服务器框架（stdio 传输、工具处理） |
| `qrcode-terminal` | 将二维码渲染为 ASCII 字符画，在终端中显示 |

---

## 常见问题排查

### 二维码显示不正常

二维码以 ASCII 方块字符渲染。如果你的终端字体不支持，会同时提供备用 URL。你可以：
- 在手机浏览器中打开该 URL——页面会显示「请使用微信扫码打开」。使用微信的扫一扫功能扫描**手机自身屏幕**（截图后从相册扫描）。
- 或者换一个 Unicode 支持更好的终端。

### 收到「Session expired」通知

微信会话过期后，通道会发送通知并停止轮询。Claude Code 需要重新调用 `wechat_login`，或者你可以重启会话：

```bash
# 删除保存的凭据并重启
rm ~/.claude/wechat-channel/credentials.json
claude --dangerously-load-development-channels server:wechat
```

### 消息没有到达 Claude Code

1. **检查白名单：** 发送者是否在 `~/.claude/wechat-channel/allowlist.json` 中？
2. **检查凭据：** `~/.claude/wechat-channel/credentials.json` 是否存在？
3. **检查进程：** 通道子进程是否在运行？（`ps aux | grep channel.mjs`）
4. **检查日志：** 通道日志输出到 stderr，前缀为 `[wechat-channel]`。

### 回复时提示「Not logged in」

在 Claude Code 中调用 `wechat_login` 工具，或重新启动带通道标志的 Claude Code。

### Node.js 版本错误

本项目需要 Node.js 22+ 以支持原生 `fetch`。如果遇到 fetch 相关错误：

```bash
node --version  # 必须是 v22.x 或更高
```

### nvm：Claude Code 启动通道时提示「node not found」

Claude Code 以子进程方式启动通道，**不会加载你的 shell 配置**，因此 nvm 的 node 不在 PATH 中。在 `.mcp.json` 中使用 node 的完整路径：

```json
{
  "mcpServers": {
    "wechat": {
      "command": "/Users/你的用户名/.nvm/versions/node/v22.22.1/bin/node",
      "args": ["/path/to/wechat-claude-code-channel/channel.mjs"]
    }
  }
}
```

运行 `./setup.sh` 可以自动检测和配置。

---

## 常见问题

**问：这是否使用了非官方/逆向工程的微信协议？**
答：不是。本项目使用微信官方的 **ilink bot 协议**（`ilinkai.weixin.qq.com`）——与腾讯自己的 [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) 插件使用的协议完全相同。

**问：需要安装 OpenClaw 吗？**
答：不需要。这是一个独立的通道，通过 MCP 直接连接 Claude Code，无需安装 OpenClaw。

**问：可以让多人向 Claude Code 发消息吗？**
答：可以，但每个发送者都必须在白名单中。扫描二维码的用户会自动添加，使用 `wechat_allow` 工具添加其他人。

**问：支持哪些消息类型？**
答：目前支持**文字消息**和**语音消息**（转写文本）。图片、文件和视频会被检测到但不会作为媒体转发——通道会标注 `[non-text message]`。

**问：登录会话能持续多久？**
答：会话由微信服务器管理，可能在数小时或数天后过期。过期后通道会通知 Claude Code，你需要重新扫描二维码。

**问：我的微信数据会发送给 Anthropic 吗？**
答：你从微信发送的消息会转发给 Claude Code，Claude Code 通过 Anthropic API 处理它们，就像处理其他 Claude Code 输入一样。通道本身只会将数据发送到 `ilinkai.weixin.qq.com`（微信通信）和 Claude Code（通过本地 stdio），不会发送到其他任何地方。

**问：可以用企业微信吗？**
答：不可以，本项目使用个人微信的 ilink bot 协议。如需企业微信，请参考 [`@wecom/aibot-node-sdk`](https://www.npmjs.com/package/@wecom/aibot-node-sdk)。

---

## 许可证

MIT
