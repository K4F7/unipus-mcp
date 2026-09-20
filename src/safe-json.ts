/**
 * JSON.parse corrupts integers outside Number.MAX_SAFE_INTEGER
 * (e.g. snowflake q_qinstid 1984905701219868673 → 1984905701219868700).
 * Quote those literals as strings before parse so digits stay exact.
 */

/** Match JSON strings OR bare integer literals with 16+ digits. */
const STRING_OR_LARGE_INT =
  /"(?:\\.|[^"\\])*"|(-?\d{16,})(?=[\s,\]}]|$)/g;

/**
 * Like JSON.parse, but integers with ≥16 digits become strings
 * (preserves q_qinstid / *Id snowflakes beyond MAX_SAFE_INTEGER).
 */
export function parseJsonPreservingLargeInts(text: string): unknown {
  const rewritten = text.replace(
    STRING_OR_LARGE_INT,
    (match, digits: string | undefined) => {
      if (digits != null) {
        return `"${digits}"`;
      }
      return match;
    },
  );
  return JSON.parse(rewritten);
}

/**
 * Parse paperJson (string or already-decoded value).
 * Nested string paperJson is parsed with large-int preservation.
 */
export function parsePaperJson(paperJson: unknown): unknown {
  if (typeof paperJson === "string") {
    const trimmed = paperJson.trim();
    if (trimmed.length === 0) {
      return null;
    }
    try {
      return parseJsonPreservingLargeInts(trimmed);
    } catch {
      return null;
    }
  }
  return paperJson ?? null;
}

const INSTANCE_ID_KEYS = new Set([
  "q_qinstid",
  "questionInstanceId",
  "instanceId",
  "question_instance_id",
]);

/**
 * Exact id string: never Number() large values (precision loss).
 * Safe integers may still arrive as numbers after parse.
 */
export function asExactIdString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isSafeInteger(value)) {
      return String(value);
    }
    // Already past JSON.parse precision — do not propagate
    return null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return null;
}

function looksLikeIdKey(key: string): boolean {
  if (INSTANCE_ID_KEYS.has(key)) {
    return true;
  }
  if (key === "taskId" || key === "task_id") {
    return true;
  }
  // *Id / *_id fields that hold snowflake-sized digit strings
  return /(?:Id|_id)$/.test(key);
}

/**
 * Walk a paper / loadPaper tree and collect exact instance id strings.
 * Prefers q_qinstid / questionInstanceId / instanceId; also *Id with ≥16 digits.
 */
export function collectQuestionInstanceIds(root: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const visit = (value: unknown): void => {
    if (value == null) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (looksLikeIdKey(key)) {
        const id = asExactIdString(child);
        if (
          id != null &&
          (INSTANCE_ID_KEYS.has(key) || /^\d{16,}$/.test(id)) &&
          key !== "taskId" &&
          key !== "task_id"
        ) {
          if (!seen.has(id)) {
            seen.add(id);
            out.push(id);
          }
        }
      }
      visit(child);
    }
  };

  visit(root);
  return out;
}

/**
 * Extract and safely parse nested paperJson from a loadPaper data object.
 */
export function extractParsedPaperJson(
  data: Record<string, unknown>,
): unknown | null {
  const raw =
    data.paperJson ?? data.paper_json ?? data.paper ?? data.content ?? null;
  if (raw == null) {
    return null;
  }
  return parsePaperJson(raw);
}
