# AGENTS.md

## 运行环境与架构概览

`weixin-bot-cli` 项目是一个专门用于与基于 iLink 协议的微信进行交互的**独立命令行工具**。
该工具的前身是高度耦合于 `openclaw` AI 网关框架的微信插件团队版本。经过了彻底的重构，现在它是一个独立的轻量级 CLI 平台。

**⚠️ 极其关键的架构限制与不变量：不得产生任何对 OPENCLAW 的依赖**
本项目的代码库**绝对不允许**导入、引用或依赖 `openclaw` 核心包的内容与体系。这个工具需要自主管理其状态写入、处理轮询循环并独立发起 API 请求。

### 核心机制

1. **状态目录与持久化存储**：
   应用的所有状态数据（包含账号 Token 签发信息，session 上下文字符串，日志以及同步位 `get_updates_buf`）现在都收敛并持久化至统一目录。
   - 默认的核心目录：`~/.weixin-bot-cli`
   - 可以通过 Node 环境变量：`process.env.WEIXIN_BOT_HOME`（或者附加命令行指令 `--home`）来重写和覆盖。
   - 实现逻辑文件参见：`src/storage/state-dir.ts`

2. **鉴权与登录机制（扫码）**：
   登录体系通过获取官方扫码 URL 并在终端窗口渲染终端可见的字符集二维码来实现，随后程序将利用 iLink 服务针对扫码状态进行长轮询直至用户在手机上操作完成。
   - 该流程由 `startWeixinLoginWithQr` 和 `waitForWeixinLogin` 方法全自动接管。
   - 最后产出的账号成功凭证将被转化为普通的 JSON 格式，经由 `saveWeixinAccount` (`src/auth/accounts.ts`) 严格序列化保存在指定的状态目录内。

3. **收信轮询逻辑（Long-Polling）**：
   位于 `src/monitor/monitor.ts` 的 `monitorWeixinProvider` 是处理 `while (!aborted)` 主工作循环的枢纽工厂。
   - 现在，该循环的任务不再是把得到的消息路由并中继给复杂的 AI 框架引擎处理，而是纯粹地在控制台上将接收到的消息流式解析并 `console.log` 给用户查看。

4. **发件能力**：
   `src/messaging/send.ts` 主要暴露了用于向对侧下发文本内容（`sendMessageWeixin`）或多媒体数据的源生底层能力。
   - 虽然现在已经完全与 AI 解绑，但在 `getUpdates` 期间服务器下发的 `context_token` 等状态绑定必须被遵循。
   - 如果用户执行 CLI 中的发送命令功能，本质是在直接触发 `sendMessageWeixin` 。

## 需了解的关键目录映射

- `src/api/`: 类型良好的 API 请求代理器封装地以及主要发包函数 `apiPostFetch` (承载着固定了官方 WeChat Headers，各个基础 version，甚至 User-Agents 伪装的核心逻辑)。
- `src/auth/`: 负责账号持久化索引保存，统筹验证机制并解析核心凭据的控制层。
- `src/cdn/`: 上传文件/图片/视频等能力层逻辑（通过这里处理后的资源才能被 Wechat API 正常映射发送出去）。
- `src/media/`: 对各类富媒体资源进行处理，例如将音频从微信的特殊 `silk` 格式转写映射成系统普遍可识别的 `wav` 等（由 `silk-wasm` 驱动）,包含媒体解密算法等。
- `src/messaging/`: 下发负荷结构的拼装层（`send.ts`），以及核心的人类输入数据结构体转化层（`inbound.ts`）。
- `src/monitor/`: 长轮询长队列拉起节点。

## 对于 AI 编写/维护工具的典型指导思想

**当你被要求为 CLI 新增一行命令能力时：**
1. 首先确认这个新功能需要何种必要参数（例如：发送操作需要知道 `to` 去哪，`text` 内容是什么或 `mediaType` 类型）。
2. 前往 `src/cli.ts` 底部新增一个基于 commander 库的新段落片段 `.command(...)`。
3. 从 `listIndexedWeixinAccountIds()` 函数中调取本地账号并提取最新的鉴权信息进行组装。
4. 所有执行必须被妥善套入 `try-catch` 控制台中，并将最后的运行结果可视化反馈在 Standard Output (例如: `console.log('✅ 发送成功')`)。

**当要修正或者升级底层微信 API 接口支持时：**
- 修改只发生在 `src/api/types.ts` 里。这里存储所有该协议对应的 Payload Req结构或者 Resp 回包定义。

**保证绝对的强类型安全与编译**：
- 这是一份合规标准的 TS 工作空间环境。在提交每一次修改重构时，务必通过控制台运行 `pnpm run typecheck`（该命令本质为 `tsc --noEmit`）以检验代码。保证代码不能遗留任何构建期错误。
