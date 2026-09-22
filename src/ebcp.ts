import {
  resolveEbcpAuthUrl,
  resolveEbcpSpeakersUrl,
} from "./config.js";
import { toolError, type ToolResult } from "./result.js";
import {
  asRecord,
  ulsAuthedJsonRequest,
  ulsCloudHeaders,
} from "./uls-business.js";
import type { AuthPorts } from "./auth.js";

/**
 * EBCP auth / speakers (ucloud). Business success code=200.
 * Same validation for both endpoints (trim scene, require object bizExt).
 */

export type EbcpPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  ebcpAuthUrl?: string;
  ebcpSpeakersUrl?: string;
};

export type EbcpInput = {
  scene: string;
  bizExt: Record<string, unknown>;
  openId?: string;
};

export type EbcpResult = ToolResult & {
  raw_code?: number | null;
  data?: unknown;
  speakers?: unknown[];
  speak_voice_tones?: unknown[];
};

export type ValidatedEbcp = {
  scene: string;
  bizExt: Record<string, unknown>;
  openId?: string;
};

/** Shared input validation for ebcpAuth and ebcpSpeakers. */
export function validateEbcpInput(
  input: EbcpInput,
): ValidatedEbcp | ToolResult {
  const scene = input.scene.trim();
  if (scene.length === 0) {
    return toolError("INVALID_ARGUMENT", "scene 不能为空");
  }
  if (
    input.bizExt == null ||
    typeof input.bizExt !== "object" ||
    Array.isArray(input.bizExt)
  ) {
    return toolError("INVALID_ARGUMENT", "bizExt 必须是对象");
  }
  return { scene, bizExt: input.bizExt, openId: input.openId };
}

async function ebcpPost(
  ports: EbcpPorts,
  input: EbcpInput,
  label: string,
  url: string,
  mapOk: (data: unknown) => Partial<EbcpResult> & { message: string },
): Promise<EbcpResult> {
  const validated = validateEbcpInput(input);
  if ("isError" in validated) {
    return validated;
  }

  const response = await ulsAuthedJsonRequest(ports, {
    label,
    url,
    method: "POST",
    headers: (jwt) => ulsCloudHeaders(jwt, ports.env, validated.openId),
    jsonBody: { scene: validated.scene, bizExt: validated.bizExt },
    successCode: 200,
    dataKeys: ["data", "value"],
  });
  if (!response.ok) {
    return response.result;
  }

  const mapped = mapOk(response.data);
  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: mapped.message,
    raw_code: response.raw_code,
    data: mapped.data ?? response.data,
    speakers: mapped.speakers,
    speak_voice_tones: mapped.speak_voice_tones,
  };
}

export async function ebcpAuth(
  ports: EbcpPorts,
  input: EbcpInput,
): Promise<EbcpResult> {
  return ebcpPost(
    ports,
    input,
    "ebcp/auth",
    ports.ebcpAuthUrl ?? resolveEbcpAuthUrl(ports.env),
    (data) => ({
      message: "已完成 ebcp/auth",
      data,
    }),
  );
}

export async function ebcpSpeakers(
  ports: EbcpPorts,
  input: EbcpInput,
): Promise<EbcpResult> {
  return ebcpPost(
    ports,
    input,
    "ebcp/speakers",
    ports.ebcpSpeakersUrl ?? resolveEbcpSpeakersUrl(ports.env),
    (data) => {
      const record = asRecord(data) ?? {};
      const speakers = Array.isArray(record.speakers) ? record.speakers : [];
      const tones = Array.isArray(record.speakVoiceTones)
        ? record.speakVoiceTones
        : [];
      return {
        message: `已读取 speakers ${speakers.length} 条`,
        speakers,
        speak_voice_tones: tones,
        data,
      };
    },
  );
}
