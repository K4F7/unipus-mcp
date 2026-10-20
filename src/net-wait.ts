/**
 * Network-outage handling for the grind (#102). A transient network failure
 * (box offline, DNS down, TLS reset) is not the paper's or the account's fault:
 * wait with backoff until a connectivity probe succeeds, then retry, instead of
 * counting it toward the paper / account stop counters. Past the cap the run
 * stops with a resumable NETWORK_DOWN reason.
 */
import { resolveNetWait } from "./limits.js";
import { activeNow, markProgress } from "./watchdog.js";

const NETWORK_RE =
  /fetch failed|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|socket hang up|socket disconnected|secure TLS connection|UND_ERR_SOCKET|UND_ERR_CONNECT|getaddrinfo|\bNETWORK(_ERROR)?:|network is unreachable/i;

/** Real failures that must never be retried as network blips (auth, refusal content, ledger write). */
const REAL_RE = /AUTH_REQUIRED|AUTH_FAILED|\b401\b|\b403\b|JWT 无效|结果写入失败|无有效答案|LLM 拒答|empty reply/i;

/** True when an error / detail text describes a transient network failure (not auth / bad LLM output). */
export function isNetworkFailure(detail: unknown): boolean {
  const text = describe(detail);
  return NETWORK_RE.test(text) && !REAL_RE.test(text);
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    const cause = (value as { cause?: { code?: string; message?: string } }).cause;
    return `${value.message} ${cause?.code ?? ""} ${cause?.message ?? ""}`;
  }
  return String(value ?? "");
}

/** Resolves true once connectivity is back, false after the cap (network still down). */
export type NetworkWaiter = (reason: string) => Promise<boolean>;

export function createNetworkWaiter(opts: {
  probe: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}): NetworkWaiter {
  const { maxMs, baseMs, capMs } = resolveNetWait(opts.env);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? activeNow;
  const log = opts.log ?? ((line: string) => console.error(line));
  // One budget per waiter (one waiter per account): repeated outages share UNIPUS_NET_WAIT_MAX_MS.
  let spentBefore = 0;
  return async (reason) => {
    const start = now();
    const waited = () => spentBefore + now() - start;
    log(`[net] 网络类失败，等待网络恢复（本号累计上限 ${Math.round(maxMs / 1000)}s，已用 ${Math.round(spentBefore / 1000)}s）：${reason}`);
    try {
      for (let attempt = 1, delay = baseMs; ; attempt++, delay = Math.min(capMs, delay * 2)) {
        if (waited() >= maxMs) {
          log(`[net] 本号累计等了 ${Math.round(waited() / 1000)}s 网络仍未恢复，放弃（可直接重跑续上）`);
          return false;
        }
        await sleep(Math.min(delay, maxMs - waited()));
        // Keeps the stall watchdog (UNIPUS_STALL_MINUTES) from killing a deliberate wait.
        markProgress(`net:wait #${attempt}`);
        const secs = Math.round((now() - start) / 1000);
        if (await opts.probe().catch(() => false)) {
          log(`[net] 第 ${attempt} 次探测网络已恢复（等了 ${secs}s），重试`);
          return true;
        }
        log(`[net] 第 ${attempt} 次探测仍不通（已等 ${secs}s）`);
      }
    } finally {
      spentBefore = waited();
    }
  };
}

/** Any HTTP response (even 401/404) from each URL means the network path is up. */
export function createHttpProbe(urls: string[], fetchImpl: typeof fetch = globalThis.fetch, timeoutMs = 10_000) {
  return async (): Promise<boolean> => {
    for (const url of urls) {
      try {
        await fetchImpl(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        return false;
      }
    }
    return true;
  };
}

/** Default waiter: probe the LLM gateway and the U校园 API host. */
export function defaultNetworkWaiter(env: NodeJS.ProcessEnv = process.env): NetworkWaiter {
  const urls = ["https://ucloud.unipus.cn/"];
  const llm = env.UNIPUS_LLM_BASE_URL?.trim();
  if (llm) urls.push(llm);
  return createNetworkWaiter({ probe: createHttpProbe(urls), env });
}

export const NETWORK_DOWN = "NETWORK_DOWN";

export function networkDownReason(detail: string): string {
  return `${NETWORK_DOWN}: 网络未恢复（已等到 UNIPUS_NET_WAIT_MAX_MS 上限），停止；重跑同一命令即可续上（已交的卷按 App 历史跳过）：${detail}`;
}
