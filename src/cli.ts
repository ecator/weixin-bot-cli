#!/usr/bin/env node

import { Command } from "commander";

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
import { monitorWeixinProvider } from "./monitor/monitor.js";
import { sendMessageWeixin } from "./messaging/send.js";
import { logger } from "./util/logger.js";
import type { WeixinMessage } from "./api/types.js";
import { extractSummary } from "./monitor/monitor.js";

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
  .option("-h, --home <path>", "Alias for --dir");

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
          logger.error(`保存账号数据失败 accountId=${waitResult.accountId} err=${String(err)}`);
          console.error(`⚠️ 保存账号数据失败: ${String(err)}`);
        }
      } else {
        console.error("❌ 登录未成功:", waitResult.message);
      }
    } catch (err) {
      console.error("❌ 登录过程中发生错误:", err);
    }
  });

program
  .command("start")
  .description("Start polling for incoming messages")
  .action(async () => {
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

    const onMessage = async (msg: WeixinMessage) => {
      const to = msg.from_user_id ?? "unknown";
      try {
        await sendMessageWeixin({
          to,
          text: `已收到：${extractSummary(msg)}`,
          opts: {
            baseUrl: accountInfo.baseUrl,
            token: accountInfo.token,
          }
        });
        console.log(`✅ 消息已成功回复给: ${to}`);
      } catch (err) {
        console.error("❌ 消息回复失败:", err);
        process.exit(1);
      }
    };

    try {
      await monitorWeixinProvider({
        baseUrl: accountInfo.baseUrl,
        token: accountInfo.token,
        accountId: accountInfo.accountId,
        onMessage,
      });
    } catch (err) {
      console.error("❌ 监听发生错误:", err);
      process.exit(1);
    }
  });

program
  .command("send <to> [text]")
  .description("发送消息，如果没有提供文本，则从标准输入读取。")
  .action(async (to, text) => {
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

    let messageText = text;
    if (!messageText) {
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

    if (!messageText) {
      console.error("❌ 消息内容不能为空。");
      process.exit(1);
    }

    try {
      await sendMessageWeixin({
        to,
        text: messageText,
        opts: {
          baseUrl: accountInfo.baseUrl,
          token: accountInfo.token,
        }
      });
      console.log(`✅ 消息已成功发送给: ${to}`);
    } catch (err) {
      console.error("❌ 消息发送失败:", err);
      process.exit(1);
    }
  });

program.parse(process.argv);
