import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { probeAuthStatus, type AuthPorts } from "./auth.js";
import { createEnvCredentialStore } from "./credentials.js";
import { createFetchUnipusHttp } from "./http.js";
import { toMcpToolResponse } from "./result.js";
import {
  startListeningTraining,
  type StartListeningPorts,
} from "./start-listening-training.js";
import { listWeekProgress, type WeekProgressPorts } from "./week-progress.js";
import {
  uploadAnswerAudio,
  type UploadAnswerAudioPorts,
} from "./upload-answer-audio.js";
import {
  submitAnswer,
  type SubmitAnswerPorts,
} from "./submit-answer.js";
import {
  speakAndSubmit,
  type SpeakAndSubmitPorts,
} from "./speak-and-submit.js";
import { z } from "zod";

const AUTH_STATUS_DESCRIPTION = [
  "Report whether a usable U听说 / U听力 (cn.unipus.cloud) JWT or SSO session is configured.",
  "Probes https://ucloud.unipus.cn/api/uls/ with Authorization Bearer.",
  "Does not accept username or password; login is env/CLI only (UNIPUS_JWT / UNIPUS_JWT_FILE).",
].join(" ");

const LIST_WEEK_PROGRESS_DESCRIPTION = [
  "List U听力 + U口语 counters from the configured progress endpoint.",
  "Default GET /api/uls/user/activation/status on uadaptive returns **试用次数**",
  "(listenTrialUsed / speakTrialUsed / trialUsageLimit) — NOT App card 模块 0/3,",
  "and NOT paid weekly quota (听力5/口语3; path still unknown).",
  "Returns listen_done/listen_total, speak_done/speak_total; progress_* aliases listen.",
  "Auth: raw JWT (no Bearer). Host: UNIPUS_ULS_ORIGIN or UNIPUS_ULS_ADAPTIVE_ORIGIN.",
  "Optional UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH for a dedicated second fetch.",
].join(" ");

const START_LISTENING_TRAINING_DESCRIPTION = [
  "Start U听力「开始训练」via POST /api/uls/user/loadPaper on uadaptive.",
  "Args: taskId (required), ansVersion (default 1), optional openId.",
  "Does not accept credentials (JWT from env/CLI only).",
].join(" ");

export type UnipusServerPorts = Partial<WeekProgressPorts> &
  Partial<StartListeningPorts> &
  Partial<UploadAnswerAudioPorts> &
  Partial<SubmitAnswerPorts> &
  Partial<SpeakAndSubmitPorts> & {
    loadPaperUrl?: string;
    queryUploadUrl?: string;
    submitAnswerUrl?: string;
  };

export function createUnipusMcpServer(ports?: UnipusServerPorts): McpServer {
  const server = new McpServer({
    name: "unipus-mcp",
    version: "0.1.0",
  });

  const authPorts: AuthPorts = {
    credentials: ports?.credentials ?? createEnvCredentialStore(),
    http: ports?.http ?? createFetchUnipusHttp(),
    now: ports?.now,
  };

  const weekPorts: WeekProgressPorts = {
    ...authPorts,
    env: ports?.env,
    weekProgressUrl: ports?.weekProgressUrl,
  };

  server.registerTool(
    "auth_status",
    {
      title: "Auth status",
      description: AUTH_STATUS_DESCRIPTION,
    },
    async () => toMcpToolResponse(await probeAuthStatus(authPorts)),
  );

  server.registerTool(
    "list_week_progress",
    {
      title: "List week progress",
      description: LIST_WEEK_PROGRESS_DESCRIPTION,
    },
    async () => toMcpToolResponse(await listWeekProgress(weekPorts)),
  );

  const startPorts: StartListeningPorts = {
    ...authPorts,
    env: ports?.env,
    loadPaperUrl: ports?.loadPaperUrl,
  };

  server.registerTool(
    "start_listening_training",
    {
      title: "Start listening training",
      description: START_LISTENING_TRAINING_DESCRIPTION,
      inputSchema: {
        taskId: z.string().min(1).describe("H5 taskId query param"),
        ansVersion: z
          .number()
          .positive()
          .optional()
          .describe("H5 ansVersion; default 1"),
        openId: z.string().optional().describe("Optional openId header"),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await startListeningTraining(startPorts, {
          taskId: args.taskId,
          ansVersion: args.ansVersion,
          openId: args.openId,
        }),
      ),
  );

  const UPLOAD_ANSWER_AUDIO_DESCRIPTION = [
    "Upload answer audio for U听力/U口语 without mic (silent path).",
    "POST /api/uls/user/answer/query-upload-url then Qiniu form upload (token,key,file).",
    "Args: filePath (required), optional fileName / openId.",
    "Returns storage_key + cdn_url; does not call submitAnswer yet.",
    "Does not accept credentials (JWT from env/CLI only).",
  ].join(" ");

  const uploadPorts: UploadAnswerAudioPorts = {
    ...authPorts,
    env: ports?.env,
    queryUploadUrl: ports?.queryUploadUrl,
    qiniuUploadUrl: ports?.qiniuUploadUrl,
    uploadFetch: ports?.uploadFetch,
    readFile: ports?.readFile,
  };

  server.registerTool(
    "upload_answer_audio",
    {
      title: "Upload answer audio",
      description: UPLOAD_ANSWER_AUDIO_DESCRIPTION,
      inputSchema: {
        filePath: z.string().min(1).describe("Local audio file path to upload"),
        fileName: z
          .string()
          .min(1)
          .optional()
          .describe("Remote file name; default basename(filePath)"),
        openId: z.string().optional().describe("Optional openId header"),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await uploadAnswerAudio(uploadPorts, {
          filePath: args.filePath,
          fileName: args.fileName,
          openId: args.openId,
        }),
      ),
  );

  const SUBMIT_ANSWER_DESCRIPTION = [
    "Submit U听力/U口语 answers via POST /api/uls/user/submitAnswer.",
    "Requires paperToken from start_listening_training / loadPaper (avoids multi-device lock).",
    "userData: [{ instanceId, answer }] — answer may be oral CDN URL (auto-wrapped) or JSON string.",
    "Does not accept credentials (JWT from env/CLI only).",
  ].join(" ");

  const submitPorts: SubmitAnswerPorts = {
    ...authPorts,
    env: ports?.env,
    submitAnswerUrl: ports?.submitAnswerUrl,
  };

  server.registerTool(
    "submit_answer",
    {
      title: "Submit answer",
      description: SUBMIT_ANSWER_DESCRIPTION,
      inputSchema: {
        taskId: z.string().min(1).describe("Task id from getUserStatus / loadPaper"),
        paperToken: z
          .string()
          .min(1)
          .describe("Token from loadPaper / start_listening_training"),
        ansVersion: z.number().positive().optional().describe("Default 1"),
        durationSec: z.number().nonnegative().optional().describe("Seconds spent; default 1"),
        instanceId: z.string().min(1).describe("Question instance id (q_qinstid)"),
        answer: z
          .string()
          .min(1)
          .describe("Answer JSON or oral audio CDN URL (auto-wrapped as record.url)"),
        openId: z.string().optional().describe("Optional openId header"),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await submitAnswer(submitPorts, {
          taskId: args.taskId,
          paperToken: args.paperToken,
          ansVersion: args.ansVersion,
          durationSec: args.durationSec,
          openId: args.openId,
          userData: [{ instanceId: args.instanceId, answer: args.answer }],
        }),
      ),
  );

  const SPEAK_AND_SUBMIT_DESCRIPTION = [
    "One-shot silent oral: TTS (edge) → upload_answer_audio → submit_answer.",
    "Requires paperToken from start_listening_training / loadPaper.",
    "Args: text, taskId, paperToken, instanceId; optional voice / ansVersion / durationSec / openId.",
    "Needs ffmpeg on PATH. Does not accept credentials.",
  ].join(" ");

  const speakPorts: SpeakAndSubmitPorts = {
    ...uploadPorts,
    submitAnswerUrl: ports?.submitAnswerUrl,
    synthesizeMp3: ports?.synthesizeMp3,
    ffmpegPath: ports?.ffmpegPath,
  };

  server.registerTool(
    "speak_and_submit",
    {
      title: "Speak and submit",
      description: SPEAK_AND_SUBMIT_DESCRIPTION,
      inputSchema: {
        text: z.string().min(1).describe("Text to speak (TTS)"),
        taskId: z.string().min(1),
        paperToken: z.string().min(1).describe("Token from loadPaper"),
        instanceId: z.string().min(1).describe("Question instance id"),
        voice: z.string().optional().describe("edge-tts voice; default en-US-JennyNeural"),
        ansVersion: z.number().positive().optional(),
        durationSec: z.number().nonnegative().optional(),
        openId: z.string().optional(),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await speakAndSubmit(speakPorts, {
          text: args.text,
          taskId: args.taskId,
          paperToken: args.paperToken,
          instanceId: args.instanceId,
          voice: args.voice,
          ansVersion: args.ansVersion,
          durationSec: args.durationSec,
          openId: args.openId,
        }),
      ),
  );

  return server;
}
