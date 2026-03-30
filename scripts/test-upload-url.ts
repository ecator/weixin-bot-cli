#!/usr/bin/env npx tsx
/**
 * 测试 GetUploadUrl 接口
 *
 * 用法:
 *   npx tsx scripts/test-upload-url.ts <base_url> <token> <to_user_id> <video_path>
 *
 * 示例:
 *   npx tsx scripts/test-upload-url.ts https://ilinkai.weixin.qq.com "your-token" xxx@im.wechat /tmp/test.mp4
 */

import crypto from "node:crypto";
import fs from "node:fs";

const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

function aesEcbPaddedSize(plainSize: number): number {
  const blockSize = 16;
  const padding = blockSize - (plainSize % blockSize);
  return plainSize + padding;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function getMediaType(filePath: string): number {
  const ext = filePath.toLowerCase().split(".").pop();
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext || "")) {
    return UploadMediaType.IMAGE;
  }
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext || "")) {
    return UploadMediaType.VIDEO;
  }
  return UploadMediaType.FILE;
}

async function testGetUploadUrl(
  baseUrl: string,
  token: string,
  toUserId: string,
  filePath: string,
): Promise<void> {
  const mediaType = getMediaType(filePath);
  const mediaTypeName = Object.entries(UploadMediaType).find(([, v]) => v === mediaType)?.[0] || "UNKNOWN";
  console.log(`\n📁 读取文件: ${filePath} (类型: ${mediaTypeName})`);


  if (!fs.existsSync(filePath)) {
    console.error(`❌ 文件不存在: ${filePath}`);
    process.exit(1);
  }

  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");

  console.log(`\n📊 文件信息:`);
  console.log(`   原文大小 (rawsize): ${rawsize} bytes`);
  console.log(`   原文 MD5 (rawfilemd5): ${rawfilemd5}`);
  console.log(`   密文大小 (filesize): ${filesize} bytes`);
  console.log(`   文件 Key (filekey): ${filekey}`);
  console.log(`   目标用户 (to_user_id): ${toUserId}`);

  const aeskey = crypto.randomBytes(16).toString("hex");

  const requestBody = {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey,
  };

  console.log(`\n📤 请求体:`);
  console.log(JSON.stringify(requestBody, null, 2));

  const bodyStr = JSON.stringify(requestBody);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(bodyStr, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
    "Authorization": `Bearer ${token}`,
  };

  console.log(`\n📝 请求头:`);
  console.log(JSON.stringify({ ...headers, Authorization: "Bearer ***" }, null, 2));

  const url = `${baseUrl.replace(/\/$/, "")}/ilink/bot/getuploadurl`;
  console.log(`\n🌐 请求 URL: ${url}`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
    });

    const rawText = await res.text();
    console.log(`\n📥 响应状态: ${res.status}`);
    console.log(`📥 响应体:`);

    try {
      const json = JSON.parse(rawText);
      console.log(JSON.stringify(json, null, 2));
    } catch {
      console.log(rawText);
    }

    if (!res.ok) {
      console.error(`\n❌ 请求失败: ${res.status}`);
    } else {
      console.log(`\n✅ 请求成功`);
    }
  } catch (err) {
    console.error(`\n❌ 请求出错:`, err);
  }
}

// 主入口
const args = process.argv.slice(2);
if (args.length < 4) {
  console.log(`
用法: npx tsx scripts/test-upload-url.ts <base_url> <token> <to_user_id> <file_path>

示例:
  npx tsx scripts/test-upload-url.ts https://ilinkai.weixin.qq.com "your-token" xxx@im.wechat /tmp/test.mp4
  npx tsx scripts/test-upload-url.ts https://ilinkai.weixin.qq.com "your-token" xxx@im.wechat /tmp/test.png
`);
  process.exit(1);
}

const [baseUrl, token, toUserId, filePath] = args;
testGetUploadUrl(baseUrl, token, toUserId, filePath);
