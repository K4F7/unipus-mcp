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
import {
  conversationChatInfo,
  conversationCreate,
  conversationMaxCount,
  conversationSave,
  conversationStop,
  ebcpAuth,
  ebcpSpeakers,
  type ConversationPorts,
} from "./conversation.js";
import {
  partSubmit,
  type PartSubmitPorts,
} from "./part-submit.js";
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
  Partial<PartSubmitPorts> &
  Partial<UploadAnswerAudioPorts> &
  Partial<SubmitAnswerPorts> &
  Partial<SpeakAndSubmitPorts> &
  Partial<GradeQuestionPorts> &
  Partial<ScoreEnSentPorts> & {
    loadPaperUrl?: string;
    loadGradedQuestionsUrl?: string;
    queryUploadUrl?: string;
    submitAnswerUrl?: string;
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


  const conversationPorts: ConversationPorts = {
    ...authPorts,
    env: ports?.env,
    conversationCreateUrl: ports?.conversationCreateUrl,
    conversationSaveUrl: ports?.conversationSaveUrl,
    conversationStopUrl: ports?.conversationStopUrl,
    conversationChatInfoUrl: ports?.conversationChatInfoUrl,
    conversationMaxCountUrl: ports?.conversationMaxCountUrl,
    ebcpAuthUrl: ports?.ebcpAuthUrl,
    ebcpSpeakersUrl: ports?.ebcpSpeakersUrl,
  };

  const CONVERSATION_CREATE_DESCRIPTION = [
    "Start AI口语对话 via POST /api/uls/conversation/create on ucloud.",
    "Business success code=200 (not uls user code=1).",
    "Headers: sourceid (default 116) + x-requested-with: cn.unipus.cloud + raw JWT.",
    "Args: taskId, questionId, title, role; optional ansVersion / sourceId / openId.",
    "Returns conversation_id, scene_id, token, level. Do NOT invent /oral/train.",
    "Does not accept credentials (JWT from env/CLI only).",
  ].join(" ");

  server.registerTool(
    "conversation_create",
    {
      title: "Conversation create",
      description: CONVERSATION_CREATE_DESCRIPTION,
      inputSchema: {
        taskId: z.string().min(1),
        questionId: z.string().min(1).describe("Question / instance id (exact string)"),
        title: z.string().min(1),
        role: z.string().min(1).describe("Dialog role (app create body)"),
        ansVersion: z.number().positive().optional().describe("Default 1"),
        sourceId: z
          .union([z.number(), z.string()])
          .optional()
          .describe("Body sourceId; default UNIPUS_U_APP_ID / 116"),
        openId: z.string().optional(),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await conversationCreate(conversationPorts, {
          taskId: args.taskId,
          questionId: args.questionId,
          title: args.title,
          role: args.role,
          ansVersion: args.ansVersion,
          sourceId: args.sourceId,
          openId: args.openId,
        }),
      ),
  );

  const CONVERSATION_SAVE_DESCRIPTION = [
    "Save one AI口语对话 turn via POST /api/uls/conversation/save (ucloud, code=200).",
    "Args: speakTaskId, duration, speakAddTaskRecord (object with bot/user audio+text fields).",
    "JWT from env/CLI only. Not /oral/train.",
  ].join(" ");

  server.registerTool(
    "conversation_save",
    {
      title: "Conversation save",
      description: CONVERSATION_SAVE_DESCRIPTION,
      inputSchema: {
        speakTaskId: z.string().min(1),
        duration: z.number().nonnegative(),
        speakAddTaskRecord: z
          .record(z.unknown())
          .describe("Turn payload: aiType, bot*/user* fields, sort, speakType, …"),
        openId: z.string().optional(),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await conversationSave(conversationPorts, {
          speakTaskId: args.speakTaskId,
          duration: args.duration,
          speakAddTaskRecord: args.speakAddTaskRecord as Record<string, unknown>,
          openId: args.openId,
        }),
      ),
  );

  const CONVERSATION_STOP_DESCRIPTION = [
    "Stop AI口语对话 via POST /api/uls/conversation/stop (ucloud, code=200).",
    "Args: speakTaskId, evaluation; optional evaluationContent / voiceToneId / openId.",
    "After stop, exit the part with part_submit action=submit. JWT env/CLI only.",
  ].join(" ");

  server.registerTool(
    "conversation_stop",
    {
      title: "Conversation stop",
      description: CONVERSATION_STOP_DESCRIPTION,
      inputSchema: {
        speakTaskId: z.string().min(1),
        evaluation: z.union([z.number(), z.string()]),
        evaluationContent: z.string().optional(),
        voiceToneId: z.string().optional(),
        openId: z.string().optional(),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await conversationStop(conversationPorts, {
          speakTaskId: args.speakTaskId,
          evaluation: args.evaluation,
          evaluationContent: args.evaluationContent,
          voiceToneId: args.voiceToneId,
          openId: args.openId,
        }),
      ),
  );

  server.registerTool(
    "conversation_chat_info",
    {
      title: "Conversation chat info",
      description:
        "GET /api/uls/conversation/chat/info?conversationId= (ucloud, code=200). Mid-dialog record.",
      inputSchema: {
        conversationId: z.string().min(1),
        openId: z.string().optional(),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await conversationChatInfo(conversationPorts, {
          conversationId: args.conversationId,
          openId: args.openId,
        }),
      ),
  );

  server.registerTool(
    "conversation_max_count",
    {
      title: "Conversation max count",
      description:
        "GET /api/uls/conversation/max-count (ucloud, code=200). UI turn cap (e.g. /10).",
      inputSchema: {
        openId: z.string().optional(),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await conversationMaxCount(conversationPorts, { openId: args.openId }),
      ),
  );

  server.registerTool(
    "ebcp_auth",
    {
      title: "EBCP auth",
      description:
        "POST /api/uls/ebcp/auth (ucloud, code=200). scene + bizExt (questionId/taskId/…). JWT env only.",
      inputSchema: {
        scene: z.string().min(1),
        bizExt: z.record(z.unknown()),
        openId: z.string().optional(),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await ebcpAuth(conversationPorts, {
          scene: args.scene,
          bizExt: args.bizExt as Record<string, unknown>,
          openId: args.openId,
        }),
      ),
  );

  server.registerTool(
    "ebcp_speakers",
    {
      title: "EBCP speakers",
      description:
        "POST /api/uls/ebcp/speakers (ucloud, code=200). Returns speakers / speakVoiceTones.",
      inputSchema: {
        scene: z.string().min(1),
        bizExt: z.record(z.unknown()),
        openId: z.string().optional(),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await ebcpSpeakers(conversationPorts, {
          scene: args.scene,
          bizExt: args.bizExt as Record<string, unknown>,
          openId: args.openId,
        }),
      ),
  );

  const partPorts: PartSubmitPorts = {
    ...authPorts,
    env: ports?.env,
    partSubmitUrl: ports?.partSubmitUrl,
  };

  const PART_SUBMIT_DESCRIPTION = [
    "POST /api/uls/part/submit for 范例学习 / AI对话退出 / 自由表达.",
    "Same URL for action=snapshot and action=submit. Business success code=1 (not 200).",
    "Args: action, taskId, partId, token (loadPaper), userData[]; optional ansVersion / duration / openId.",
    "Free speak: build EN_PRED_SCORE answer (buildEnPredScoreQuestionContent), snapshot then submit.",
    "Do NOT invent /oral/train. JWT from env/CLI only.",
  ].join(" ");

  server.registerTool(
    "part_submit",
    {
      title: "Part submit",
      description: PART_SUBMIT_DESCRIPTION,
      inputSchema: {
        action: z.enum(["snapshot", "submit"]),
        taskId: z.string().min(1),
        partId: z.string().min(1),
        token: z.string().min(1).describe("loadPaper / start_*_training paper token"),
        ansVersion: z.number().positive().optional(),
        duration: z.number().nonnegative().optional(),
        userData: z
          .array(
            z.object({
              instanceId: z.string().min(1),
              answer: z.union([z.string(), z.record(z.unknown())]),
              answerVersion: z.number().optional(),
              context: z.union([z.string(), z.record(z.unknown())]).optional(),
              contextVersion: z.number().optional(),
              instStatus: z.union([z.number(), z.string()]).optional(),
            }),
          )
          .min(1),
        openId: z.string().optional(),
      },
    },
    async (args) =>
      toMcpToolResponse(
        await partSubmit(partPorts, {
          action: args.action,
          taskId: args.taskId,
          partId: args.partId,
          token: args.token,
          ansVersion: args.ansVersion,
          duration: args.duration,
          userData: args.userData as Array<{
            instanceId: string;
            answer: string | Record<string, unknown>;
            answerVersion?: number;
            context?: string | Record<string, unknown>;
            contextVersion?: number;
            instStatus?: number | string;
          }>,
          openId: args.openId,
        }),
      ),
  );

  return server;
}

