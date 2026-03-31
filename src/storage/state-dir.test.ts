import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "./state-dir.js";

describe("resolveStateDir", () => {
  afterEach(() => {
    delete process.env.WEIXIN_BOT_CLI_HOME;
  });

  it("returns WEIXIN_BOT_CLI_HOME when set", () => {
    process.env.WEIXIN_BOT_CLI_HOME = "/custom/state";
    expect(resolveStateDir()).toBe("/custom/state");
  });

  it("falls back to ~/.weixin-bot-cli when env var is unset", () => {
    delete process.env.WEIXIN_BOT_CLI_HOME;
    const expected = path.join(os.homedir(), ".weixin-bot-cli");
    expect(resolveStateDir()).toBe(expected);
  });

  it("trims whitespace and falls back when WEIXIN_BOT_CLI_HOME is blank", () => {
    process.env.WEIXIN_BOT_CLI_HOME = "   ";
    const expected = path.join(os.homedir(), ".weixin-bot-cli");
    expect(resolveStateDir()).toBe(expected);
  });
});
