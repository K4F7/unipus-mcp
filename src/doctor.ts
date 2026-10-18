/**
 * Environment self-check for harness agents (#88). Read-only, no network, no
 * synthesis, never prints secrets (LLM key → configured true/false only).
 */
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { resolveOralWsTimeoutMs, resolveOralWsTurnMaxMs } from "./ai-dialog-flow.js";
import { resolveHttpTimeoutMs } from "./http.js";
import { resolveResultsFile } from "./paper-result.js";
import { resolveFfmpegPath, resolveLocalTtsEngine, resolveLocalTtsScript, resolveTtsEngine, SAY_BIN } from "./tts.js";
import { resolveStallMs } from "./watchdog.js";

export type DoctorCheck = { name: string; ok: boolean; detail: string };
export type DoctorReport = { ok: boolean; platform: NodeJS.Platform; checks: DoctorCheck[] };

function onPath(bin: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | null {
  if (isAbsolute(bin)) return exists(bin) ? bin : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && exists(join(dir, bin))) return join(dir, bin);
  }
  return null;
}

export function doctorReport(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): DoctorReport {
  const checks: DoctorCheck[] = [];
  const ffmpeg = onPath(resolveFfmpegPath(env), env, exists);
  checks.push({ name: "ffmpeg", ok: ffmpeg != null, detail: ffmpeg ?? `未找到 ${resolveFfmpegPath(env)}（可设 UNIPUS_FFMPEG_BIN）` });

  const engine = resolveLocalTtsEngine(env, false, platform);
  if (engine === "say") {
    const ok = platform === "darwin" && exists(SAY_BIN);
    checks.push({ name: "tts", ok, detail: `say（macOS 默认，-o 写文件不外放）${ok ? SAY_BIN : "：仅 macOS 可用"}` });
  } else if (engine) {
    const script = resolveLocalTtsScript(env);
    checks.push({ name: "tts", ok: exists(script), detail: `${engine}（${platform === "darwin" ? "显式指定" : "非 macOS 默认"}） ${script}` });
  } else {
    checks.push({ name: "tts", ok: true, detail: `legacy ${resolveTtsEngine(env)}（已弃用）` });
  }

  checks.push({ name: "llm", ok: true, detail: `UNIPUS_LLM_API_KEY ${env.UNIPUS_LLM_API_KEY?.trim() ? "已配置" : "未配置"}` });
  const stall = resolveStallMs(env);
  checks.push({
    name: "timeouts",
    ok: true,
    detail:
      `oral WS 无数据 ${resolveOralWsTimeoutMs(env)}ms / 每轮上限 ${resolveOralWsTurnMaxMs(env)}ms；` +
      `HTTP ${resolveHttpTimeoutMs(env)}ms；stall ${stall ? `${stall / 60_000} 分钟` : "关闭"}`,
  });
  checks.push({ name: "results", ok: true, detail: resolveResultsFile(env) });
  return { ok: checks.every((c) => c.ok), platform, checks };
}
