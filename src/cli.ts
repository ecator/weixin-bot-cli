#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";

import { startWeixinLoginWithQr, waitForWeixinLogin } from "./auth/login-qr.js";
import {
  saveWeixinAccount,
  registerWeixinAccountId,
  clearStaleAccountsForUserId,
  normalizeAccountId,
  resolveWeixinAccount,
  listIndexedWeixinAccountIds,
  DEFAULT_BASE_URL,
} from "./auth/accounts.js";
import { extractContentBlocks, monitorWeixinProvider } from "./monitor/monitor.js";
import { sendMessageWeixin } from "./messaging/send.js";
import { sendWeixinMediaFile } from "./messaging/send-media.js";
import { logger } from "./util/logger.js";
import type { WeixinMessage } from "./api/types.js";
import { extractSummary } from "./monitor/monitor.js";
import { AcpManager } from "./acp/client.js";
import { getConfig, sendTyping } from "./api/api.js";
import { WeixinConfigManager } from "./api/config-cache.js";
import type { Logger } from "./util/logger.js";
import type { ContentBlock } from "@agentclientprotocol/sdk";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf-8"));

const program = new Command();

program
  .name("weixin-bot-cli")
  .description("Weixin Bot CLI for receiving messages")
  .version(pkg.version)
  .option("-d, --dir <path>", "Home directory for data storage (overrides ~/.weixin-bot-cli)")
  .option("-h, --home <path>", "Alias for --dir")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    const homeDir = opts.home || opts.dir;
    if (homeDir) {
      process.env.WEIXIN_BOT_CLI_HOME = homeDir;
      console.log(`WEIXIN_BOT_CLI_HOME overrides to: ${homeDir}`);
    }
  });

program
  .command("login")
  .description("Login to WeChat via QR code")
  .action(async () => {
    try {
      console.log("🚀 开始获取登录二维码...");
      const startResult = await startWeixinLoginWithQr({
        apiBaseUrl: DEFAULT_BASE_URL,
        verbose: true,
      });

      if (!startResult.qrcodeUrl) {
        console.error("❌ 获取二维码失败:", startResult.message);
        return;
      }

      console.log("\n⏳ 等待微信扫码并确认...");
      const waitResult = await waitForWeixinLogin({
        sessionKey: startResult.sessionKey,
        apiBaseUrl: DEFAULT_BASE_URL,
        verbose: true,
      });

      if (waitResult.connected && waitResult.botToken && waitResult.accountId) {
        try {
          const normalizedId = normalizeAccountId(waitResult.accountId);
          saveWeixinAccount(normalizedId, {
            token: waitResult.botToken,
            baseUrl: waitResult.baseUrl || DEFAULT_BASE_URL,
            userId: waitResult.userId,
          });
          registerWeixinAccountId(normalizedId);
          if (waitResult.userId) {
            clearStaleAccountsForUserId(normalizedId, waitResult.userId);
          }
          console.log(`\n✅ 登录成功！已保存账号凭证 (Account ID: ${normalizedId})`);
        } catch (err) {
          logger.error(`⚠️ 保存账号数据失败 accountId=${waitResult.accountId} err=${String(err)}`);
        }
      } else {
        logger.error(`❌ 登录未成功:${waitResult.message}`);
      }
    } catch (err) {
      console.error("❌ 登录过程中发生错误:", err);
    }
  });

program
  .command("start")
  .description("Start polling for incoming messages, and reply to messages using ACP if --acp-cmd is provided")
  .option("--acp-cmd <command>", "Command to start the ACP server (e.g. \"gemini --acp\")")
  .option("--acp-session <sessionId>", "Reuse an existing ACP session ID")
  .option("--acp-timeout <seconds>", "Timeout in seconds for each ACP prompt", (value) => {
    const n = Number(value);
    if (Number.isNaN(n)) {
      throw new InvalidArgumentError(`"${value}" is not a valid number.`);
    }
    if (!Number.isInteger(n) || n <= 0) {
      throw new InvalidArgumentError("Must be a positive integer.");
    }
    return n;
  }, 600)
  .action(async (opts) => {
    const ids = listIndexedWeixinAccountIds();
    if (ids.length === 0) {
      console.error("❌ 未找到已登录的账号，请先运行 `weixin-bot-cli login`。");
      process.exit(1);
    }
    const accountId = ids[0];
    const accountInfo = resolveWeixinAccount(accountId);

    if (!accountInfo.token) {
      console.error(`❌ 账号 ${accountId} 凭证无效或未配置。`);
      process.exit(1);
    }

    let acpManager: AcpManager | null = null;
    let acpSessionId: string | null = null;

    const connectAcp = async () => {
      if (opts.acpCmd) {
        console.log(`🚀 正在${acpManager ? "重启" : "启动"}ACP: ${opts.acpCmd}`);
        const acpCmdList = opts.acpCmd.split(" ");
        acpManager = new AcpManager(acpCmdList[0], acpCmdList.slice(1));
        try {
          const acpIntialResult = await acpManager.connect();
          logger.debug(`🔗 ACP初始化结果: \n${JSON.stringify(acpIntialResult, null, 2)}`);
          logger.debug(`🤖 现有会话列表: \n${(await acpManager.listSessions()).join("\n")}`);
          if (opts.acpSession) {
            acpSessionId = opts.acpSession;
            logger.info(`⏳ 加载会话: ${acpSessionId}`)
            await acpManager.loadSession(acpSessionId!);
            logger.info(`💬 复用会话: ${acpSessionId}`);
          } else {
            acpSessionId = await acpManager.createSession();
            logger.info(`🆕 创建新会话: ${acpSessionId}`);
          }
        } catch (err) {
          console.error("❌ 无法连接到ACP:", err);
          process.exit(1);
        }
      }
    };
    await connectAcp();

    const configManager = new WeixinConfigManager({ baseUrl: accountInfo.baseUrl, token: accountInfo.token }, (msg) => logger.debug(msg));
    const onMessage = async (msg: WeixinMessage) => {
      const to = msg.from_user_id ?? "unknown";
      const id = msg.message_id ?? "unknown";
      try {
        const userTextSummary = extractSummary(msg);
        const prompt = await extractContentBlocks(msg, accountInfo.cdnBaseUrl);
        let replyText = `已收到：${userTextSummary}`;
        console.log(`\n📨 [收到消息][${id}] 来自: ${to}`);
        console.log(`> ${userTextSummary}`);

        // 插入微信消息元数据，让AI了解消息的上下文
        prompt.unshift({
          type: "text",
          text: `<weixin_message_metadata>\nfrom_user_id: ${to}\nsystem_datetime: ${new Date().toString()}\n</weixin_message_metadata>`,
        });

        if (acpManager && acpSessionId) {
          console.log(`\n⏳ 将消息[${id}]发送给ACP并等待响应...`);
          logger.debug(JSON.stringify(prompt.map((block) => {
            if (block.type === "image" || block.type === "audio") {
              return { ...block, data: "...<truncated>" };
            }
            return block;
          })));

          // 获取"正在输入"状态的ticket
          const { typingTicket } = await configManager.getForUser(to, msg.context_token);
          // 定义发送"正在输入"状态的函数, status: 1表示正在输入, 2表示取消
          const triggerTyping = async (status: 1 | 2) => {
            if (!typingTicket) {
              return;
            }
            try {
              await sendTyping({
                baseUrl: accountInfo.baseUrl,
                token: accountInfo.token,
                body: {
                  ilink_user_id: to,
                  typing_ticket: typingTicket,
                  status: status,
                },
              });
            } catch (e) {
              // 静默忽略定时状态重发过程中的偶尔网络波动
            }
          }

          // 立即发送第一次"正在输入"状态
          triggerTyping(1);
          // 随后每隔 10 秒刷新一次"正在输入"状态，防止回复时间过长导致"正在输入"状态超时
          const typingInterval = setInterval(() => { void triggerTyping(1); }, 10_000);
          // 最多尝试3次数
          for (let i = 1; i <= 3; i++) {
            try {
              // 转发给ACP获取回复
              const acpTimeoutMs = opts.acpTimeout * 1000;
              const acpResponse = await acpManager.prompt(acpSessionId, prompt, acpTimeoutMs);
              if (acpResponse) {
                replyText = acpResponse;
              } else {
                replyText = "ACP没有返回任何文本";
              }
              // 成功后立即跳出重试循环
              break;
            } catch (err) {
              const errStr = typeof err === "object" && err !== null && "message" in err ? err.message : String(err);
              logger.error(`onMessage callback error(count=${i}): ${errStr}`);
              if (i < 3) {
                acpManager?.close();
                await connectAcp();
              } else {
                replyText = `[ACP Error]\n${errStr}`;
              }
            }
          }
          // ACP响应后，清除重发定时器
          clearInterval(typingInterval);
          // 取消"正在输入"状态
          triggerTyping(2);
        }

        await sendMessageWeixin({
          to,
          text: replyText,
          opts: {
            baseUrl: accountInfo.baseUrl,
            token: accountInfo.token,
          }
        });
        console.log(`\n✅ 消息[${id}]已成功回复给: ${to}`);
        console.log(`< ${replyText.slice(0, 100)}${replyText.length > 100 ? "...<truncated>" : ""}`);
      } catch (err) {
        const errStr = typeof err === "object" && err !== null && "message" in err ? err.message : String(err);
        logger.error(`onMessage callback error: ${errStr}`);
      }
    };

    try {
      console.log("\n⏳ 开始监听微信消息...");
      await monitorWeixinProvider({
        baseUrl: accountInfo.baseUrl,
        token: accountInfo.token,
        accountId: accountInfo.accountId,
        onMessage,
      });
    } catch (err) {
      logger.error(`monitorWeixinProvider error: ${String(err)}`);
      process.exit(1);
    }
  });

program
  .command("send <to> [text]")
  .description("Send a message to a WeChat user. If no text is provided, reads from stdin. Use --files to attach files.")
  .option("--files <paths...>", "Send one or more files (image/video/document)")
  .action(async (to, text, opts) => {
    const ids = listIndexedWeixinAccountIds();
    if (ids.length === 0) {
      console.error("❌ 未找到已登录的账号，请先运行 `weixin-bot-cli login`。");
      process.exit(1);
    }

    const accountInfo = resolveWeixinAccount(ids[0]);
    if (!accountInfo.token) {
      console.error("❌ 账号凭证无效。");
      process.exit(1);
    }

    // 1. 处理文本：有则直接用，没有并且没有传递文件则读 stdin
    let messageText = text as string | undefined;
    if (!messageText && (opts.files ?? []).length == 0) {
      try {
        messageText = await new Promise<string>((resolve, reject) => {
          let buf = "";
          process.stdin.setEncoding("utf-8");
          process.stdin.on("data", (chunk) => { buf += chunk; });
          process.stdin.on("end", () => resolve(buf.trim()));
          process.stdin.on("error", reject);
        });
      } catch (err) {
        console.error("❌ 读取标准输入失败:", err);
        process.exit(1);
      }
    }

    if (!messageText && !opts.files?.length) {
      console.error("❌ 消息内容和文件不能同时为空。");
      process.exit(1);
    }

    // 2. 先发文本
    if (messageText) {
      try {
        await sendMessageWeixin({
          to,
          text: messageText,
          opts: { baseUrl: accountInfo.baseUrl, token: accountInfo.token },
        });
        console.log(`✅ 消息已成功发送给: ${to}`);
      } catch (err) {
        console.error("❌ 消息发送失败:", err);
        process.exit(1);
      }
    }

    // 3. 再发文件
    const filePaths: string[] = opts.files ?? [];
    for (const [index, filePath] of filePaths.entries()) {
      if (!fs.existsSync(filePath)) {
        console.error(`❌ 文件不存在，跳过: ${filePath}`);
        continue;
      }
      try {
        console.log(`[${index + 1}/${filePaths.length}] 🚀 正在发送文件: ${filePath}`);
        const result = await sendWeixinMediaFile({
          filePath,
          to,
          text: "",
          opts: { baseUrl: accountInfo.baseUrl, token: accountInfo.token },
          cdnBaseUrl: accountInfo.cdnBaseUrl,
        });
        console.log(`✅ 文件发送成功 (ID: ${result.messageId})`);
      } catch (err) {
        console.error(`❌ 文件 [${filePath}] 发送失败:`, err);
      }
    }
  });

program.parse(process.argv);
