import os from "node:os";
import path from "node:path";

/** Resolve the state directory for weixin-bot-cli. */
export function resolveStateDir(): string {
  return (
    process.env.WEIXIN_BOT_CLI_HOME?.trim() ||
    path.join(os.homedir(), ".weixin-bot-cli")
  );
}
