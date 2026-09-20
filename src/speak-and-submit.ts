import { requireConfiguredJwt, type AuthPorts } from "./auth.js";
import {
  toolError,
  type ToolResult,
} from "./result.js";
import { synthesizeSpeechWav, type SynthesizeSpeechPorts } from "./tts.js";
import {
  uploadAnswerAudio,
  type UploadAnswerAudioPorts,
} from "./upload-answer-audio.js";
import {
  submitAnswer,
  type SubmitAnswerPorts,
} from "./submit-answer.js";
import { asExactIdString } from "./safe-json.js";

export type SpeakAndSubmitInput = {
  text: string;
  taskId: string;
  paperToken: string;
  instanceId: string;
  voice?: string;
  ansVersion?: number;
  durationSec?: number;
  openId?: string;
};

export type SpeakAndSubmitPorts = AuthPorts &
  UploadAnswerAudioPorts &
  SubmitAnswerPorts &
  SynthesizeSpeechPorts;

export type SpeakAndSubmitResult = ToolResult & {
  wav_path?: string;
  storage_key?: string;
  cdn_url?: string;
  upload_hash?: string | null;
  task_id?: string;
  instance_id?: string;
};

/**
 * One-shot silent oral path: TTS → upload_answer_audio → submit_answer.
 */
export async function speakAndSubmit(
  ports: SpeakAndSubmitPorts,
  input: SpeakAndSubmitInput,
): Promise<SpeakAndSubmitResult> {
  const text = input.text.trim();
  if (text.length === 0) {
    return toolError("INVALID_ARGUMENT", "text 不能为空");
  }
  const taskId = (asExactIdString(input.taskId) ?? input.taskId).trim();
  const paperToken = input.paperToken.trim();
  const instanceId = (
    asExactIdString(input.instanceId) ?? input.instanceId
  ).trim();
  if (!taskId || !paperToken || !instanceId) {
    return toolError(
      "INVALID_ARGUMENT",
      "taskId / paperToken / instanceId 均不能为空",
    );
  }

  const loaded = await requireConfiguredJwt(ports.credentials);
  if (!loaded.ok) {
    return loaded.result;
  }

  let wavPath = "";
  let cleanup: (() => Promise<void>) | null = null;
  try {
    const spoken = await synthesizeSpeechWav(
      { text, voice: input.voice },
      ports,
    );
    wavPath = spoken.wavPath;
    cleanup = spoken.cleanup;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("TTS_ERROR", `TTS 失败：${detail}`);
  }

  try {
    const uploaded = await uploadAnswerAudio(ports, {
      filePath: wavPath,
      fileName: `tts-${instanceId}.wav`,
      openId: input.openId,
    });
    if (uploaded.isError) {
      return uploaded;
    }

    const cdn = uploaded.cdn_url;
    if (cdn == null || cdn.length === 0) {
      return toolError("UPLOAD_ERROR", "上传成功但缺少 cdn_url");
    }

    // Do not return wav_path: finally cleanup deletes the temp dir before the
    // caller sees the result, so any path would already be stale.
    const uploadedMeta = {
      storage_key: uploaded.storage_key,
      cdn_url: cdn,
      upload_hash: uploaded.upload_hash ?? null,
    };

    const submitted = await submitAnswer(ports, {
      taskId,
      paperToken,
      ansVersion: input.ansVersion,
      durationSec: input.durationSec,
      openId: input.openId,
      userData: [{ instanceId, answer: cdn }],
    });
    if (submitted.isError) {
      return { ...submitted, ...uploadedMeta };
    }

    return {
      isError: false,
      status: "ok",
      code: "OK",
      message: `TTS+上传+提交完成 instance=${instanceId}`,
      ...uploadedMeta,
      task_id: taskId,
      instance_id: instanceId,
    };
  } finally {
    try {
      await cleanup?.();
    } catch {
      // ignore temp cleanup errors
    }
  }
}

