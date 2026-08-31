export function googleOAuthJavaScriptOrigin(
  serverKey: string,
  redirectUri: string | null | undefined,
): string | null {
  if (serverKey !== "google-drive" || !redirectUri) return null;
  try {
    const url = new URL(redirectUri);
    if (url.username || url.password) return null;
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
