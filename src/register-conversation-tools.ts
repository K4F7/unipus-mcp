import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AuthPorts } from "./auth.js";
import {
  conversationChatInfo,
  conversationCreate,
  conversationMaxCount,
  conversationSave,
  conversationStop,
  type ConversationPorts,
} from "./conversation.js";
import {
  ebcpAuth,
  ebcpSpeakers,
  type EbcpPorts,
} from "./ebcp.js";
import { toMcpToolResponse } from "./result.js";

export type ConversationToolPorts = ConversationPorts & EbcpPorts;

export function registerConversationTools(
  server: McpServer,
  authPorts: AuthPorts,
  ports?: Partial<ConversationToolPorts>,
): void {
  const conversationPorts: ConversationPorts & EbcpPorts = {
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
    "Returns conversation_id, scene_id, token, level.",
    "IMPORTANT: returned token is a dialog token — NOT the loadPaper / part_submit paper token.",
    "save/stop speakTaskId must equal this conversation_id (alias conversationId accepted).",
    "Do NOT invent /oral/train. JWT from env/CLI only.",
  ].join(" ");

  server.registerTool(
    "conversation_create",
    {
      title: "Conversation create",
      description: CONVERSATION_CREATE_DESCRIPTION,
      inputSchema: {
        taskId: z.string().min(1),
        questionId: z
          .string()
          .min(1)
          .describe("Question / instance id (exact string)"),
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
    "speakTaskId === create’s conversation_id (alias: conversationId).",
    "Args: speakTaskId|conversationId, duration, speakAddTaskRecord (bot/user audio+text fields).",
    "JWT from env/CLI only. Not /oral/train.",
  ].join(" ");

  server.registerTool(
    "conversation_save",
    {
      title: "Conversation save",
      description: CONVERSATION_SAVE_DESCRIPTION,
      inputSchema: {
        speakTaskId: z
          .string()
          .min(1)
          .optional()
          .describe("Same as create’s conversation_id"),
        conversationId: z
          .string()
          .min(1)
          .optional()
          .describe("Alias for speakTaskId (create’s conversation_id)"),
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
          conversationId: args.conversationId,
          duration: args.duration,
          speakAddTaskRecord: args.speakAddTaskRecord as Record<
            string,
            unknown
          >,
          openId: args.openId,
        }),
      ),
  );

  const CONVERSATION_STOP_DESCRIPTION = [
    "Stop AI口语对话 via POST /api/uls/conversation/stop (ucloud, code=200).",
    "speakTaskId === create’s conversation_id (alias: conversationId).",
    "Args: speakTaskId|conversationId, evaluation; optional evaluationContent / voiceToneId / openId.",
    "After stop, exit the part with part_submit action=submit (needs loadPaper paper token, not create token).",
    "JWT env/CLI only.",
  ].join(" ");

  server.registerTool(
    "conversation_stop",
    {
      title: "Conversation stop",
      description: CONVERSATION_STOP_DESCRIPTION,
      inputSchema: {
        speakTaskId: z
          .string()
          .min(1)
          .optional()
          .describe("Same as create’s conversation_id"),
        conversationId: z
          .string()
          .min(1)
          .optional()
          .describe("Alias for speakTaskId (create’s conversation_id)"),
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
          conversationId: args.conversationId,
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
        "POST /api/uls/ebcp/speakers (ucloud, code=200). Returns speakers / speakVoiceTones. Same validation as ebcp_auth.",
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
}
