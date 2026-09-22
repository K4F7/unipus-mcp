import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AuthPorts } from "./auth.js";
import {
  partSubmit,
  type PartSubmitPorts,
} from "./part-submit.js";
import { toMcpToolResponse } from "./result.js";

export function registerPartSubmitTool(
  server: McpServer,
  authPorts: AuthPorts,
  ports?: Partial<PartSubmitPorts> & { partSubmitUrl?: string },
): void {
  const partPorts: PartSubmitPorts = {
    ...authPorts,
    env: ports?.env,
    partSubmitUrl: ports?.partSubmitUrl,
  };

  const PART_SUBMIT_DESCRIPTION = [
    "POST /api/uls/part/submit for 范例学习 / AI对话退出 / 自由表达.",
    "Same URL for action=snapshot and action=submit. Business success code=1 (not 200).",
    "Args: action, taskId, partId, token (loadPaper paper token — NOT conversation_create token),",
    "userData[]; optional ansVersion / duration / openId.",
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
        token: z
          .string()
          .min(1)
          .describe("loadPaper / start_*_training paper token (not conversation create token)"),
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
}
