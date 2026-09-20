/**
 * Live Clio WSS smoke (gated).
 *
 *   UNIPUS_CLIO_LIVE_SMOKE=1 npx tsx scripts/clio-score-smoke.ts
 *
 * Optional: UNIPUS_CLIO_APP_ID / UNIPUS_CLIO_APP_SECRET / UNIPUS_CLIO_WSS_URL
 * Default credentials = SPA phoneme pair (public in mobile/core.js).
 * Does not print secrets.
 */
import { scoreEnSent } from "../src/clio-speech.js";
import { resolveClioCredentials, resolveClioWssUrl } from "../src/config.js";
import { synthesizeSpeechWav } from "../src/tts.js";

async function main(): Promise<void> {
  if (process.env.UNIPUS_CLIO_LIVE_SMOKE?.trim() !== "1") {
    console.error(
      "Skip: set UNIPUS_CLIO_LIVE_SMOKE=1 to run live Clio WSS smoke.",
    );
    process.exit(0);
  }

  const transcript = process.argv[2]?.trim() || "hello world";
  const creds = resolveClioCredentials(process.env);
  const wss = resolveClioWssUrl(process.env);
  console.log(
    JSON.stringify({
      transcript,
      wss,
      credentials: creds != null ? "env-override" : "spa-phoneme-default",
      applicationIdPrefix: (creds?.applicationId ?? "162787294610001").slice(
        0,
        6,
      ),
    }),
  );

  const { wavPath, cleanup } = await synthesizeSpeechWav({ text: transcript });
  try {
    const scored = await scoreEnSent({
      transcript,
      wavPath,
      userId: "unipus-mcp-smoke",
      timeoutMs: 45_000,
    });
    const url = scored.audioUrl ?? "";
    console.log(
      JSON.stringify({
        ok: true,
        overall: scored.overall,
        total: scored.total,
        audioUrlTruncated:
          url.length > 64 ? `${url.slice(0, 48)}…${url.slice(-12)}` : url,
        resultKeys: Object.keys(scored.result),
      }),
    );
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: detail }));
  process.exit(1);
});
