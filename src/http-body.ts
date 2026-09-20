/** Short, safe snippet from an HTTP error body (JSON message or raw text). */
export function summarizeHttpErrorBody(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      const message = (value as { message?: unknown }).message;
      if (typeof message === "string" && message.trim().length > 0) {
        return message.trim().slice(0, 200);
      }
    }
  } catch {
    // fall through to raw body snippet
  }
  return trimmed.slice(0, 200);
}
