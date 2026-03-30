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

const program = new Command();

program
  .name("weixin-bot-cli")
  .description("Weixin Bot CLI for receiving messages")
  .version("1.0.0")
  .option("-d, --dir <path>", "Home directory for data storage (overrides ~/.weixin-bot-cli)")
  .option("-h, --home <path>", "Alias for --dir")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    const homeDir = opts.home || opts.dir;
    if (homeDir) {
      process.env.WEIXIN_BOT_HOME = homeDir;
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

    try {
      await monitorWeixinProvider({
        baseUrl: accountInfo.baseUrl,
        token: accountInfo.token,
        accountId: accountInfo.accountId,
      });
    } catch (err) {
      console.error("❌ 监听发生错误:", err);
      process.exit(1);
    }
  });

program
  .command("send <to> <text>")
  .description("Send a text message to a specific WeChat user")
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

    try {
      await sendMessageWeixin({
        to,
        text,
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
