import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getSession, resetRateLimit, verifyCSRFToken } from "@/lib/auth";
import { setPassword } from "@/lib/identity/provider";
import { validateIdentityPassword } from "@/lib/identity/password-policy";
import { verifyUser } from "@/lib/identity/store";

const MAX_ATTEMPTS = 6;
const WINDOW_SECONDS = 15 * 60;

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session || session.authMethod === "cli") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const csrf = request.headers.get("X-CSRF-Token");
  if (!csrf || !(await verifyCSRFToken(csrf))) return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });

  const key = `self-password:${session.username}`;
  const limit = checkRateLimit(key, MAX_ATTEMPTS, WINDOW_SECONDS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many password attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((limit.resetAt - Date.now()) / 1000)) } },
    );
  }

  const body = await request.json().catch(() => ({}));
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const repeatPassword = typeof body.repeatPassword === "string" ? body.repeatPassword : "";
  const passwordError = validateIdentityPassword(newPassword);
  if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
  if (newPassword !== repeatPassword) return NextResponse.json({ error: "Passwords do not match" }, { status: 400 });
  if (newPassword === currentPassword) return NextResponse.json({ error: "Choose a different password" }, { status: 400 });

  const user = await verifyUser(session.username, currentPassword);
  if (!user) return NextResponse.json({ error: "Current password is incorrect", remaining: limit.remaining }, { status: 400 });

  await setPassword(user.id, newPassword);
  resetRateLimit(key);
  return NextResponse.json({ success: true });
}
