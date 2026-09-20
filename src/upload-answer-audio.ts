import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { requireConfiguredJwt, type AuthPorts } from "./auth.js";
import { resolveQueryUploadUrl } from "./config.js";
import { summarizeHttpErrorBody } from "./http.js";
import {
  authRequired,
  okUploadAnswerAudio,
  toolError,
  type UploadAnswerAudioResult,
} from "./result.js";

export type UploadAnswerAudioInput = {
  /** Absolute or relative path to audio file (wav/pcm/mp3/…). */
  filePath: string;
  /** Override remote file name; default = basename(filePath). */
  fileName?: string;
  openId?: string;
};

export type UploadAnswerAudioPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  queryUploadUrl?: string;
  /** Qiniu form POST; default https://up-z1.qiniup.com */
  qiniuUploadUrl?: string;
  /** Injected for tests; defaults to global fetch (Qiniu is outside UnipusHttp allowlist). */
  uploadFetch?: typeof fetch;
  readFile?: (path: string) => Promise<Buffer>;
};

const DEFAULT_QINIU_UPLOAD = "https://up-z1.qiniup.com";

/**
 * Silent audio path: POST query-upload-url → Qiniu multipart (token,key,file).
 * Does not submit the answer; returns CDN url + storage key for later submitAnswer.
 */
export async function uploadAnswerAudio(
  ports: UploadAnswerAudioPorts,
  input: UploadAnswerAudioInput,
): Promise<UploadAnswerAudioResult> {
  const filePath = input.filePath.trim();
  if (filePath.length === 0) {
    return toolError("INVALID_ARGUMENT", "filePath 不能为空");
  }
  const fileName = input.fileName?.trim() || basename(filePath) || "answer.wav";
  if (fileName.length === 0) {
    return toolError("INVALID_ARGUMENT", "fileName 不能为空");
  }

  const loaded = await requireConfiguredJwt(ports.credentials);
  if (!loaded.ok) {
    return loaded.result;
  }

  const bytes = await readAudioBytes(ports, filePath);
  if (!bytes.ok) {
    return bytes.result;
  }

  const queryUrl = ports.queryUploadUrl ?? resolveQueryUploadUrl(ports.env);
  const headers: Record<string, string> = {
    // uadaptive gateway rejects "Bearer " prefix
    authorization: loaded.jwt,
    "content-type": "application/json",
  };
  const openId = input.openId?.trim();
  if (openId != null && openId.length > 0) {
    headers.openId = openId;
  }

  let queryResponse: { statusCode: number; body: string };
  try {
    queryResponse = await ports.http.request({
      url: queryUrl,
      method: "POST",
      headers,
      body: JSON.stringify({ fileName }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("NETWORK_ERROR", `query-upload-url 网络失败：${detail}`);
  }

  if (queryResponse.statusCode === 401) {
    const hint = summarizeHttpErrorBody(queryResponse.body);
    return authRequired(
      hint != null
        ? `query-upload-url 401：${hint}`
        : "query-upload-url 401：JWT 无效或已过期",
    );
  }
  if (queryResponse.statusCode < 200 || queryResponse.statusCode >= 300) {
    const hint = summarizeHttpErrorBody(queryResponse.body);
    return toolError(
      "HTTP_ERROR",
      hint != null
        ? `query-upload-url HTTP ${queryResponse.statusCode}：${hint}`
        : `query-upload-url HTTP ${queryResponse.statusCode}`,
    );
  }

  const cred = parseQueryUploadBody(queryResponse.body);
  if (cred == null) {
    return toolError(
      "PARSE_ERROR",
      "query-upload-url 响应无法解析（需 code 成功且含 token/path）",
    );
  }

  const qiniuUrl = ports.qiniuUploadUrl ?? DEFAULT_QINIU_UPLOAD;
  const uploadFetch = ports.uploadFetch ?? globalThis.fetch;

  const form = new FormData();
  form.append("token", cred.token);
  form.append("key", cred.path);
  form.append(
    "file",
    new Blob([bytes], { type: guessAudioMime(fileName) }),
    fileName,
  );

  let uploadResponse: Response;
  try {
    uploadResponse = await uploadFetch(qiniuUrl, { method: "POST", body: form });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("NETWORK_ERROR", `七牛上传网络失败：${detail}`);
  }

  const uploadText = await uploadResponse.text();
  if (!uploadResponse.ok) {
    return toolError(
      "UPLOAD_ERROR",
      `七牛上传 HTTP ${uploadResponse.status}：${uploadText.slice(0, 200)}`,
    );
  }

  let uploadHash: string | null = null;
  try {
    const parsed: unknown = JSON.parse(uploadText);
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const hash = (parsed as Record<string, unknown>).hash;
      if (typeof hash === "string") {
        uploadHash = hash;
      }
    }
  } catch {
    // Qiniu may return non-JSON on some configs; HTTP ok is enough.
  }

  return okUploadAnswerAudio({
    message: `答题音频已上传：${fileName}`,
    file_name: fileName,
    storage_key: cred.path,
    cdn_url: cred.url,
    upload_hash: uploadHash,
  });
}

async function readAudioBytes(
  ports: UploadAnswerAudioPorts,
  filePath: string,
): Promise<
  | { ok: true; buffer: Buffer }
  | { ok: false; result: UploadAnswerAudioResult }
> {
  const read = ports.readFile ?? ((p: string) => readFile(p));
  try {
    const buffer = await read(filePath);
    if (buffer.length === 0) {
      return {
        ok: false,
        result: toolError("INVALID_ARGUMENT", "音频文件为空"),
      };
    }
    return { ok: true, buffer };
  } catch (error) {
    if (
      error != null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return {
        ok: false,
        result: toolError("INVALID_ARGUMENT", `找不到音频文件：${filePath}`),
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      result: toolError("IO_ERROR", `读取音频失败：${detail}`),
    };
  }
}

export function parseQueryUploadBody(body: string): {
  token: string;
  path: string;
  url: string;
} | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (!isBusinessSuccess(record)) {
    return null;
  }
  const value = record.value ?? record.data;
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  const token = pickString(v, ["token", "uploadToken", "upToken"]);
  const path = pickString(v, ["path", "key", "fileKey", "fileName"]);
  const url = pickString(v, ["url", "defaultUrl", "cdnUrl"]) ?? "";
  if (token == null || path == null) {
    return null;
  }
  return { token, path, url };
}

function isBusinessSuccess(record: Record<string, unknown>): boolean {
  const code = record.code;
  if (
    code === 0 ||
    code === 1 ||
    code === 200 ||
    code === "0" ||
    code === "1" ||
    code === "200"
  ) {
    return true;
  }
  if (record.success === true) {
    return true;
  }
  return false;
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function guessAudioMime(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".pcm")) return "application/octet-stream";
  if (lower.endsWith(".webm")) return "audio/webm";
  return "application/octet-stream";
}
