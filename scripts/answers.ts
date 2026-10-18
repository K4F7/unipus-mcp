#!/usr/bin/env node
/** Local agent handoff. Response text is stdin, never a shell argument. */
import { readFile } from "node:fs/promises";
import { listAgentAnswerRequests, replyToAgentAnswerRequest, resolveAgentAnswerDir } from "../src/agent-answers.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    console.log(`Usage:
  npm run answers -- list [--all]
  npm run answers -- reply <request_id> [--file /absolute/path/to/answer.txt]
Set UNIPUS_AGENT_ANSWER_DIR to the same absolute directory as weekly-grind.
list returns pending prompts as JSON; --all includes answered prompts for repair.
reply reads plain spoken text or answer JSON from stdin (or --file) and publishes atomically.
The running harness resumes automatically; after it exits, rerun the original command.`);
    return;
  }
  const dir = resolveAgentAnswerDir();
  if (!dir) throw new Error("Set UNIPUS_AGENT_ANSWER_DIR to an absolute directory");
  if (command === "list" && (args.length === 0 || (args.length === 1 && args[0] === "--all"))) {
    console.log(JSON.stringify({ queue_dir: dir, requests: await listAgentAnswerRequests(dir, { includeAnswered: args[0] === "--all" }) }, null, 2));
    return;
  }
  if (command === "reply" && (args.length === 1 || (args.length === 3 && args[1] === "--file"))) {
    const response = args[2] != null
      ? await readFile(args[2], "utf8")
      : await new Promise<string>((resolve, reject) => {
        let text = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { text += chunk; });
        process.stdin.on("end", () => resolve(text));
        process.stdin.on("error", reject);
      });
    await replyToAgentAnswerRequest(dir, args[0]!, response);
    console.log(JSON.stringify({ status: "ok", request_id: args[0] }));
    return;
  }
  throw new Error("Usage: answers list [--all] | reply <request_id> [--file <path>]");
}

main().catch((error) => {
  console.log(JSON.stringify({ status: "error", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
