import { serve } from "bun";
import { createSessionToken, verifyToken } from "./session";

const PORT = Number.parseInt(process.env.PORT ?? "3030", 10);
const SECRET = process.env.OPENBOT_SESSION_SECRET?.trim();
if (!SECRET || SECRET.length < 32) throw new Error("OPENBOT_SESSION_SECRET must contain at least 32 characters.");
const GATEWAY_URL = process.env.CHATGPT_GATEWAY_URL?.replace(/\/$/, "");
if (!GATEWAY_URL?.startsWith("https://")) throw new Error("CHATGPT_GATEWAY_URL must be an HTTPS URL.");

const COOKIE = "openbot_edge_session";

serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ status: "ok" });

    if (url.pathname === "/edge-login") {
      const bootstrap = await verifyToken(url.searchParams.get("token") ?? "", SECRET, "bootstrap");
      if (!bootstrap) return new Response("Недействительная или истёкшая ссылка входа.", { status: 401 });
      const session = await createSessionToken(bootstrap.sub, SECRET);
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": `${COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`,
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/edge-logout") {
      const signOutUrl = `${GATEWAY_URL}/signout-with-chatgpt?return_to=%2F`;
      return new Response(null, {
        status: 302,
        headers: {
          location: signOutUrl,
          "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/auth") {
      const token = readCookie(request.headers.get("cookie") ?? "", COOKIE);
      const session = token ? await verifyToken(token, SECRET, "session") : null;
      return new Response(null, {
        status: session ? 204 : 401,
        headers: { "cache-control": "no-store" },
      });
    }

    return new Response("Not found.", { status: 404 });
  },
});

function readCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}
