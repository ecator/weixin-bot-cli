# weixin-bot-cli

这是一个轻量级、独立的微信命令行工具（CLI）。它支持通过终端二维码登录微信、实时接收微信消息，并通过命令行直接发送基础的文本消息。还可以作为ACP客户端连接ACP服务端，实现智能回复。

该项目基于官方 iLink 微信协议，直接获取配置并将收到的消息稳定地输出到标准终端。它完全独立运行，**不依赖**庞大复杂的插件系统或任何 AI 框架代理层，非常适合用于编写自定义自动化脚本或进行终端调试。

## 功能特性

- **二维码认证登录**：安全地在终端获取和扫描二维码来完成微信会话登录。
- **消息监听**：内置长轮询（Long-polling）机制实时监听收件箱，并打印结构化的消息日志。
- **发送消息**：直接通过命令行 `send` 指令向指定微信联系人发送纯文本消息。
- **原生媒体支持**：代码库底层保留了媒体处理的支持（详见 `src/media`，`src/cdn`），基于 TypeScript 的内部 API 设计允许开发者后续轻松扩展发送图片、视频和文件等功能。
- **独立免数据库存储**：告别重量级数据库依赖，所有账号凭证和会话状态均默认以纯文本和 JSON 的形式保存在物理文件系统 `~/.weixin-bot-cli` 下。
- **TypeScript 构建**：现代化的强类型代码库，编译为开箱即用的 ES Modules。

## 环境要求

- Node.js >= 22

## 使用方法

账号配置文件和状态数据的默认存放路径为用户的 `~/.weixin-bot-cli`。如果需要修改数据目录，你可以通过 `-h` 或 `--home` 参数进行覆盖，同样也支持设置 `WEIXIN_BOT_CLI_HOME` 环境变量。

### 1. 登录

初始化二维码扫码登录流程。
它会在终端生成登录二维码。请使用手机微信扫描屏幕上的二维码完成授权。

```bash
npx @ecat/weixin-bot-cli login

# 可选拓展：将账号数据存放在自定义路径下
npx @ecat/weixin-bot-cli --home D:/my-data login
```

### 2. 启动监听

登录成功后，即可启动长轮询监听模式。该命令将挂起并持续运行，只要你的微信账号收到新消息，就会实时解析并将发件人和正文打印到控制台中。

```bash
npx @ecat/weixin-bot-cli start
```

也可以启动ACP客户端连接ACP服务端，实现智能回复。

```bash
npx @ecat/weixin-bot-cli start --acp-cmd "gemini --acp" 
```

如果需要复用原来的session可以使用--acp-session参数指定session id。

```bash
npx @ecat/weixin-bot-cli start --acp-cmd "gemini --acp" --acp-session "session-123"
```

### 3. 发送消息

你可以在不中断 CLI 运行的情况下（或开个新终端），通过命令行的形式给特定的用户发送纯文本消息。（注：必须携带接收方的 微信 User ID）
发送命令前请确保已经运行过 login 命令。

```bash
npx @ecat/weixin-bot-cli send <接收方的_user_id> "Hello，这是来自命令行的测试消息！"
# 或者通过标准输入发送大段内容
cat message.txt | npx @ecat/weixin-bot-cli send <接收方的_user_id>
```

可以通过`--files`来发送文件。

```bash
npx @ecat/weixin-bot-cli send <接收方的_user_id> [可选的文本消息] --files cat.jpg dog.mp3 bird.docx monkey.xlsx
```

## 项目目录架构

- `src/cli.ts` - 核心命令入口，定义了 Commander 路由与其绑定的命令事件。
- `src/auth/` - 认证相关操作包，包括二维码获取、扫描轮询，以及本地持久化凭证文件写入逻辑（`accounts.ts`）。
- `src/api/` - 底层通信实现，对 iLink API 进行了直接封装（包括 `getupdates`, `sendmessage`, `getconfig` 等）。
- `src/monitor/` - 核心长轮询工作器 Worker 处理循环逻辑。
- `src/messaging/` - 消息发送模块，暴露可以独立发文本、处理内部 Markdown 以及组装 WeChat 发送上下文的基础 API。
- `src/acp/` - Agent Client Protocol 客户端，用于与 Agent Client Protocol 服务器进行通信。

## 开发

建议将仓库克隆至本地，编译后运行即可。

```bash
# 安装依赖
pnpm install

# 编译项目
pnpm run build

# 运行
node dist/cli.js
```
