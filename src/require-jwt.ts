import type { JwtCredentialStore } from "./credentials.js";
import { authRequired, type AuthStatusResult } from "./result.js";

export type JwtOrAuth =
  | { ok: true; jwt: string }
  | { ok: false; result: AuthStatusResult };

/** Load JWT from the credential store, or a stable auth_required ToolResult. */
export async function requireConfiguredJwt(
  credentials: JwtCredentialStore,
): Promise<JwtOrAuth> {
  let jwt: string | null;
  try {
    jwt = await credentials.getJwt();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, result: authRequired(`读取凭据失败：${detail}`) };
  }

  if (jwt == null || jwt.trim().length === 0) {
    return {
      ok: false,
      result: authRequired(
        "未找到 UNIPUS_JWT / UNIPUS_JWT_FILE（或默认 ~/.config/unipus-mcp/jwt）",
      ),
    };
  }

  return { ok: true, jwt };
}
