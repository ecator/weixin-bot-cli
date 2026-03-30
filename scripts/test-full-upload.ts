#!/usr/bin/env npx tsx
/**
 * 完整测试媒体上传流程：getUploadUrl -> 加密 -> 上传 CDN
 *
 * 用法:
 *   npx tsx scripts/test-full-upload.ts <base_url> <cdn_base_url> <token> <to_user_id> <file_path>
 *
 * 示例:
 *   npx tsx scripts/test-full-upload.ts \
 *     https://ilinkai.weixin.qq.com \
 *     https://cdn.example.com \
 *     "your-token" \
 *     xxx@im.wechat \
 *     /tmp/test.png
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

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
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

function getMediaTypeName(mediaType: number): string {
  return Object.entries(UploadMediaType).find(([, v]) => v === mediaType)?.[0] || "UNKNOWN";
}

async function getUploadUrl(params: {
  baseUrl: string;
  token: string;
  filekey: string;
  mediaType: number;
  toUserId: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  aeskey: string;
}): Promise<{ upload_param?: string; upload_full_url?: string; ret?: number }> {
  const { baseUrl, token, filekey, mediaType, toUserId, rawsize, rawfilemd5, filesize, aeskey } = params;

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

  const bodyStr = JSON.stringify(requestBody);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(bodyStr, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
    "Authorization": `Bearer ${token}`,
  };

  const url = `${baseUrl.replace(/\/$/, "")}/ilink/bot/getuploadurl`;

  console.log(`\n📤 [1/3] 获取上传 URL...`);
  console.log(`   请求 URL: ${url}`);
  console.log(`   请求体: ${JSON.stringify(requestBody, null, 2)}`);

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: bodyStr,
  });

  const rawText = await res.text();
  const json = JSON.parse(rawText);
  console.log(`   响应: ${JSON.stringify(json, null, 2)}`);

  return json;
}

function buildCdnUploadUrl(params: {
  cdnBaseUrl: string;
  uploadParam: string;
  filekey: string;
}): string {
  const { cdnBaseUrl, uploadParam, filekey } = params;
  const base = cdnBaseUrl.replace(/\/$/, "");
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function uploadToCdn(params: {
  cdnBaseUrl: string;
  uploadParam?: string;
  uploadFullUrl?: string;
  filekey: string;
  ciphertext: Buffer;
}): Promise<{ encryptParam?: string; status: number }> {
  const { cdnBaseUrl, uploadParam, uploadFullUrl, filekey, ciphertext } = params;

  const trimmedFull = uploadFullUrl?.trim();
  let cdnUrl: string;
  if (trimmedFull) {
    cdnUrl = trimmedFull;
  } else if (uploadParam) {
    cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  } else {
    throw new Error("uploadToCdn: need upload_full_url or upload_param");
  }

  console.log(`\n📤 [3/3] 上传到 CDN...`);
  console.log(`   CDN URL: ${cdnUrl.slice(0, 100)}...`);
  console.log(`   密文大小: ${ciphertext.length} bytes`);

  const res = await fetch(cdnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });

  const encryptParam = res.headers.get("x-encrypted-param") ?? undefined;
  const errorMsg = res.headers.get("x-error-message");

  console.log(`   响应状态: ${res.status}`);
  if (errorMsg) {
    console.log(`   错误信息: ${errorMsg}`);
  }
  if (encryptParam) {
    console.log(`   x-encrypted-param: ${encryptParam.slice(0, 50)}...`);
  }

  return { encryptParam, status: res.status };
}

async function testFullUpload(
  baseUrl: string,
  cdnBaseUrl: string,
  token: string,
  toUserId: string,
  filePath: string,
): Promise<void> {
  const mediaType = getMediaType(filePath);
  const mediaTypeName = getMediaTypeName(mediaType);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`📁 完整上传测试`);
  console.log(`${"=".repeat(60)}`);
  console.log(`   文件: ${filePath}`);
  console.log(`   类型: ${mediaTypeName} (${mediaType})`);
  console.log(`   API: ${baseUrl}`);
  console.log(`   CDN: ${cdnBaseUrl}`);
  console.log(`   目标用户: ${toUserId}`);

  if (!fs.existsSync(filePath)) {
    console.error(`\n❌ 文件不存在: ${filePath}`);
    process.exit(1);
  }

  // 读取文件并计算信息
  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  // 写死 aeskey 用于测试
  const aeskey = Buffer.from("3ab68cee8c33053a25f348386f7586f9", "hex");

  console.log(`\n📊 文件信息:`);
  console.log(`   原文大小: ${rawsize} bytes`);
  console.log(`   原文 MD5: ${rawfilemd5}`);
  console.log(`   密文大小: ${filesize} bytes`);
  console.log(`   文件 Key: ${filekey}`);
  console.log(`   AES Key:  ${aeskey.toString("hex")}`);

  // Step 1: 获取上传 URL
  const uploadUrlResp = await getUploadUrl({
    baseUrl,
    token,
    filekey,
    mediaType,
    toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString("hex"),
  });

  const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    console.error(`\n❌ 获取上传 URL 失败: ret=${uploadUrlResp.ret}`);
    process.exit(1);
  }

  console.log(`\n✅ 获取上传 URL 成功`);
  if (uploadFullUrl) {
    console.log(`   upload_full_url: ${uploadFullUrl.slice(0, 80)}...`);
  }
  if (uploadParam) {
    console.log(`   upload_param: ${uploadParam.slice(0, 50)}...`);
  }

  // Step 2: AES-128-ECB 加密
  console.log(`\n🔐 [2/3] AES-128-ECB 加密...`);
  const ciphertext = encryptAesEcb(plaintext, aeskey);
  console.log(`   加密完成，密文大小: ${ciphertext.length} bytes`);

  // Step 3: 上传到 CDN
  const uploadResult = await uploadToCdn({
    cdnBaseUrl,
    uploadFullUrl: uploadFullUrl || undefined,
    uploadParam: uploadParam ?? undefined,
    filekey,
    ciphertext,
  });

  if (uploadResult.status !== 200 || !uploadResult.encryptParam) {
    console.error(`\n❌ CDN 上传失败`);
    process.exit(1);
  }

  // 输出最终结果
  console.log(`\n${"=".repeat(60)}`);
  console.log(`✅ 上传完成！`);
  console.log(`${"=".repeat(60)}`);
  console.log(`\n📋 下行消息所需信息:`);
  console.log(`{`);
  console.log(`  "media": {`);
  console.log(`    "encrypt_query_param": "${uploadResult.encryptParam}",`);
  console.log(`    "aes_key": "${Buffer.from(aeskey.toString("hex")).toString("base64")}",`);
  console.log(`    "encrypt_type": 1`);
  console.log(`  },`);
  if (mediaType === UploadMediaType.IMAGE) {
    console.log(`  "mid_size": ${filesize}`);
  } else if (mediaType === UploadMediaType.VIDEO) {
    console.log(`  "video_size": ${filesize}`);
  } else {
    console.log(`  "len": "${rawsize}"`);
  }
  console.log(`}`);
}

// 主入口
const args = process.argv.slice(2);
if (args.length < 5) {
  console.log(`
用法: npx tsx scripts/test-full-upload.ts <base_url> <cdn_base_url> <token> <to_user_id> <file_path>

示例:
  npx tsx scripts/test-full-upload.ts \\
    https://ilinkai.weixin.qq.com \\
    https://cdn.example.com \\
    "your-token" \\
    xxx@im.wechat \\
    /tmp/test.png
`);
  process.exit(1);
}

const [baseUrl, cdnBaseUrl, token, toUserId, filePath] = args;
testFullUpload(baseUrl, cdnBaseUrl, token, toUserId, filePath);
