import { clientIp, hitRateLimit, limitKey } from "@/server/auth/rate-limit";
import { readUnsubscribeToken, stopDigestEmail } from "@/server/digest/unsubscribe";

/**
 * The digest email's unsubscribe link (public, signed: server/digest/unsubscribe.ts). GET shows a page with one button
 * (link scanners fetch GETs, so a GET never unsubscribes); POST turns the email off: the button, or a mail provider's
 * one-click request (RFC 8058, List-Unsubscribe-Post). 30 a minute per IP; a bad token is a bare 400.
 */
const page = (body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Weekly digest email</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;font-size:16px;line-height:1.5">${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );

async function check(request: Request) {
  const { allowed } = await hitRateLimit(limitKey("digest-unsubscribe", clientIp(request)), 30, 60_000);
  if (!allowed) return { error: new Response("Too many requests", { status: 429 }) };
  const token = new URL(request.url).searchParams.get("token");
  const reader = readUnsubscribeToken(token);
  if (!reader) return { error: new Response("Bad request", { status: 400 }) };
  return { reader, token: token! };
}

export async function GET(request: Request) {
  const c = await check(request);
  if (c.error) return c.error;
  // The token is base64url + "." only (checked above), so it is safe in the attribute as is.
  return page(`<h1 style="font-size:1.25rem">Stop the weekly digest email?</h1><p>You'll still see your digest in the app.</p><form method="post" action="?token=${c.token}"><button type="submit" style="font-size:16px;padding:.5rem 1rem">Stop the emails</button></form>`);
}

export async function POST(request: Request) {
  const c = await check(request);
  if (c.error) return c.error;
  await stopDigestEmail(c.reader.userId);
  return page(`<h1 style="font-size:1.25rem">You won't get the weekly digest by email any more.</h1><p>You can turn it back on from your account menu.</p>`);
}
