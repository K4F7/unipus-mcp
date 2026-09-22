import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { probeAuthStatus, type AuthPorts } from "./auth.js";
import { createEnvCredentialStore } from "./credentials.js";
import { createFetchUnipusHttp } from "./http.js";
import { toMcpToolResponse } from "./result.js";
import {
  startListeningTraining,
  type StartListeningPorts,
} from "./start-listening-training.js";
import {
  startSpeakingTraining,
  type StartSpeakingPorts,
} from "./start-speaking-training.js";
import {
  loadGradedQuestions,
  type LoadGradedQuestionsPorts,
} from "./load-graded-questions.js";
import type { ConversationPorts } from "./conversation.js";
import type { EbcpPorts } from "./ebcp.js";
import type { PartSubmitPorts } from "./part-submit.js";
import { registerConversationTools } from "./register-conversation-tools.js";
import { registerPartSubmitTool } from "./register-part-submit-tool.js";
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
  saveSnapshot,
  type SaveSnapshotPorts,
} from "./save-snapshot.js";
import {
  speakAndSubmit,
  type SpeakAndSubmitPorts,
} from "./speak-and-submit.js";
import {
  gradeQuestion,
  type GradeQuestionPorts,
} from "./grade-question.js";
import {
  scoreSpeechTool,
  type ScoreEnSentPorts,
} from "./clio-speech.js";
import { z } from "zod";

const AUTH_STATUS_DESCRIPTION = [
  "Report whether a usable U听说 / U听力 (cn.unipus.cloud) JWT or SSO session is configured.",
  "Probes https://ucloud.unipus.cn/api/uls/ with Authorization Bearer.",
  "Does not accept username or password; login is env/CLI only (UNIPUS_JWT / UNIPUS_JWT_FILE).",
].join(" ");

const LIST_WEEK_PROGRESS_DESCRIPTION = [
  "List U听力 + U口语 week progress.",
  "Default: GET https://ucloud.unipus.cn/api/uls/user/getUserStatusForApp?flowType=listen and flowType=speak.",
  "本周计数 = weekDoneTaskCount (listen_done / speak_done).",
  "达标数 = weekFrequency (listen_total / speak_total).",
  "Read both from the response. Do not hardcode 3 or 6. weekTotalTaskCount is not either number.",
  "Legacy single-GET: set UNIPUS_ULS_WEEK_PROGRESS_PATH or ports.weekProgressUrl.",
  "Also send header u-app-id (default 116, override UNIPUS_U_APP_ID). That value is the server's sourceId.",
  "progress_* aliases listen. Auth: raw JWT (no Bearer). Host: UNIPUS_ULS_ORIGIN or ucloud.",
].join(" ");

const START_LISTENING_TRAINING_DESCRIPTION = [
  "Start U听力「开始训练」via POST /api/uls/user/loadPaper on uadaptive.",
  "Args: taskId (required), ansVersion (default 1), optional openId.",
  "Returns task_id, paper_token, and instance_ids (exact q_qinstid strings; BigInt-safe).",
  "Does not accept credentials (JWT from env/CLI only).",
].join(" ");

const START_SPEAKING_TRAINING_DESCRIPTION = [
  "Start U口语「开始/继续训练」: resolve taskId/ansVersion via",
  "GET getUserStatusForApp?flowType=speak (u-app-id default 116), then same POST loadPaper as listening.",
  "Optional overrides: taskId, ansVersion, openId. Do not invent /oral/train.",
  "Do NOT call while an App WebView session is open — part/submit may return 4021 (multi-device).",
  "AI对话: conversation_* + part_submit; 自由表达: EN_PRED_SCORE + part_submit. Returns same shape as start_listening_training.",
  "Does not accept credentials (JWT from env/CLI only).",
].join(" ");

const LOAD_GRADED_QUESTIONS_DESCRIPTION = [
  "Read graded results via POST /api/uls/user/loadGradedQuestions (adaptive or ucloud).",
  "Args: taskId (required), optional ansVersion (default 1) and openId.",
  "Headers: raw JWT + u-app-id (default 116). Empty list is OK for in-progress tasks.",
  "GET with query returns code 500 — use POST only. Does not invent scores.",
  "Does not accept credentials (JWT from env/CLI only).",
].join(" ");

export type UnipusServerPorts = Partial<WeekProgressPorts> &
  Partial<StartListeningPorts> &
  Partial<StartSpeakingPorts> &
  Partial<LoadGradedQuestionsPorts> &
  Partial<ConversationPorts> &
  Partial<EbcpPorts> &
  Partial<PartSubmitPorts> &
  Partial<UploadAnswerAudioPorts> &
  Partial<SubmitAnswerPorts> &
  Partial<SaveSnapshotPorts> &
  Partial<SpeakAndSubmitPorts> &
  Partial<GradeQuestionPorts> &
  Partial<ScoreEnSentPorts> & {
    loadPaperUrl?: string;
    loadGradedQuestionsUrl?: string;
    queryUploadUrl?: string;
    submitAnswerUrl?: string;
    saveSnapshotUrl?: string;
    gradeQuestionUrl?: string;
    partSubmitUrl?: string;
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

  const speakStartPorts: StartSpeakingPorts = {
    ...authPorts,
    env: ports?.env,
    loadPaperUrl: ports?.loadPaperUrl,
  };

  server.registerTool(
    "start_speaking_training",
    {
      title: "Start speaking training",
      description: START_SPEAKING_TRAINING_DESCRIPTION,
      inputSchema: {
        taskId: z
          .string()
          .min(1)
          .optional()
          .describe("Optional; default from getUserStatusForApp?flowType=speak"),
        ansVersion: z
          .number()
          .positive()
          .optional()
          .describe("Optional; default from speak status (else 1 after resolve)"),
        openId: z.string().optional().describe("Optional openId header"),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await startSpeakingTraining(speakStartPorts, {
          taskId: args.taskId,
          ansVersion: args.ansVersion,
          openId: args.openId,
        }),
      ),
  );

  const gradedPorts: LoadGradedQuestionsPorts = {
    ...authPorts,
    env: ports?.env,
    loadGradedQuestionsUrl: ports?.loadGradedQuestionsUrl,
  };

  server.registerTool(
    "load_graded_questions",
    {
      title: "Load graded questions",
      description: LOAD_GRADED_QUESTIONS_DESCRIPTION,
      inputSchema: {
        taskId: z.string().min(1).describe("Task id from loadPaper / status"),
        ansVersion: z
          .number()
          .positive()
          .optional()
          .describe("Default 1"),
        openId: z.string().optional().describe("Optional openId header"),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await loadGradedQuestions(gradedPorts, {
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

  const SAVE_SNAPSHOT_DESCRIPTION = [
    "Save a listening-paper oral snapshot via POST /api/uls/user/saveSnapshot",
    "(raw JWT + sourceid/u-app-id 116 + x-requested-with: cn.unipus.cloud).",
    "Listening Post-listening oral fill / read-aloud path:",
    "upload_answer_audio → in-app SOE → save_snapshot → grade_question.",
    "Do NOT use submit_answer or part_submit for these items (capture #27 S5).",
    "Body: { taskId, ansVersion, token, duration, userData };",
    "userData answers often contain EN_SENT_SCORE / EN_SENT_REC.",
    "Success business code=1. Keep large ids as strings.",
    "Does not accept credentials (JWT from env/CLI only).",
    "Score caveat: UI ring (e.g. 87) and grade_question.value.score (e.g. 173)",
    "are different fields — do not conflate.",
  ].join(" ");

  const saveSnapshotPorts: SaveSnapshotPorts = {
    ...authPorts,
    env: ports?.env,
    saveSnapshotUrl: ports?.saveSnapshotUrl,
  };

  server.registerTool(
    "save_snapshot",
    {
      title: "Save snapshot",
      description: SAVE_SNAPSHOT_DESCRIPTION,
      inputSchema: {
        taskId: z.string().min(1).describe("Task id from getUserStatus / loadPaper"),
        paperToken: z
          .string()
          .min(1)
          .describe("Token from loadPaper / start_listening_training"),
        ansVersion: z.number().positive().optional().describe("Default 1"),
        durationSec: z.number().nonnegative().optional().describe("Seconds spent; default 1"),
        instanceId: z.string().min(1).describe("Question instance id (q_qinstid, exact string)"),
        answer: z
          .string()
          .min(1)
          .describe("Answer JSON (often EN_SENT_SCORE / EN_SENT_REC under children)"),
        openId: z.string().optional().describe("Optional openId header"),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await saveSnapshot(saveSnapshotPorts, {
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


  const GRADE_QUESTION_DESCRIPTION = [
    "Grade one answer via POST /api/uls/rate/gradeQuestion (raw JWT, no Bearer).",
    "Args: taskId, questionInstanceId (string snowflake), questionContent (answer JSON),",
    "optional ansVersion / isObjective / openId.",
    "CDN-url-only oral record often returns score=0; prefer children[0].record",
    "EN_SENT_SCORE (type/text/url/path/replayUrl/list + child isDone) from score_speech.",
    "Pre-submit scoring: use score_speech (Clio WSS en.sent.score); do not invent scores.",
    "After submit, use load_graded_questions (POST loadGradedQuestions + u-app-id).",
    "Does not accept credentials (JWT from env/CLI only).",
  ].join(" ");

  const gradePorts: GradeQuestionPorts = {
    ...authPorts,
    env: ports?.env,
    gradeQuestionUrl: ports?.gradeQuestionUrl,
  };

  server.registerTool(
    "grade_question",
    {
      title: "Grade question",
      description: GRADE_QUESTION_DESCRIPTION,
      inputSchema: {
        taskId: z.string().min(1).describe("Task id (exact string)"),
        questionInstanceId: z
          .string()
          .min(1)
          .describe("q_qinstid as exact string (never Number-coerce)"),
        questionContent: z
          .string()
          .min(1)
          .describe("Answer JSON string (questionContent)"),
        ansVersion: z.number().positive().optional().describe("Default 1"),
        isObjective: z
          .boolean()
          .optional()
          .describe("SPA optional; false for subjective/oral when known"),
        openId: z.string().optional().describe("Optional openId header"),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await gradeQuestion(gradePorts, {
          taskId: args.taskId,
          questionInstanceId: args.questionInstanceId,
          questionContent: args.questionContent,
          ansVersion: args.ansVersion,
          isObjective: args.isObjective,
          openId: args.openId,
        }),
      ),
  );


  const SCORE_SPEECH_DESCRIPTION = [
    "Headless Clio / speech.unipus.cn en.sent.score over WSS.",
    "Args: transcript + wavPath (16 kHz mono WAV); optional userId.",
    "Credentials: UNIPUS_CLIO_APP_ID / UNIPUS_CLIO_APP_SECRET (default = SPA phoneme pair);",
    "WSS: UNIPUS_CLIO_WSS_URL (default wss://speech.unipus.cn/speech/proxy/wss).",
    "Returns overall/total, audio_url (clio-audios), children-shaped en_sent_score_content for grade/submit.",
    "Does not fake scores; silence may yield total=0. Keep grade_question separate.",
  ].join(" ");

  const scorePorts: ScoreEnSentPorts = {
    env: ports?.env,
    readFile: ports?.readFile,
    createWebSocket: ports?.createWebSocket,
    nowMs: ports?.nowMs,
    randomUUID: ports?.randomUUID,
  };

  server.registerTool(
    "score_speech",
    {
      title: "Score speech (Clio)",
      description: SCORE_SPEECH_DESCRIPTION,
      inputSchema: {
        transcript: z
          .string()
          .min(1)
          .describe("Reference transcript for en.sent.score"),
        wavPath: z
          .string()
          .min(1)
          .describe("Local 16 kHz mono WAV path"),
        userId: z.string().optional().describe("Clio userId; default unipus-mcp"),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await scoreSpeechTool(scorePorts, {
          transcript: args.transcript,
          wavPath: args.wavPath,
          userId: args.userId,
        }),
      ),
  );


  registerConversationTools(server, authPorts, ports);
  registerPartSubmitTool(server, authPorts, ports);

  return server;
}

