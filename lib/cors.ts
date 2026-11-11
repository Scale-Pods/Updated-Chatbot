/**
 * CORS headers for the chat proxy endpoints.
 *
 * The embeddable widget can run on a third-party site, so it calls this app's
 * `/api/chat/*` routes cross-origin. The real upstream URLs stay server-side;
 * only these proxy routes are public. Set `CHAT_ALLOWED_ORIGIN` to lock the
 * endpoints down to a specific site, or leave it as `*`.
 */
export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": process.env.CHAT_ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}
