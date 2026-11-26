import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/prisma", () => ({ prisma: {} }));

import { checkSystemToken, SYSTEM_TOKEN_MESSAGES, SystemTokenRefused } from "@/server/integrations/meta-ads-token";
import { PROVIDERS } from "@/server/integrations/providers";

const TOKEN = "EAABsystemtoken0123456789abcdef";
const APP = "1234567890";
const SECRET = "app-secret-xyz";
const ACCOUNT = { id: "act_1", name: "B&C ads", currency: "EUR", timezone_name: "Europe/Paris", account_status: 1 };
const debug = (extra: object = {}) => ({ data: { app_id: APP, type: "SYSTEM_USER", is_valid: true, expires_at: 0, scopes: ["ads_read", "business_management"], ...extra } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stubFetch(...responses: Response[]) {
  const f = vi.fn();
  for (const r of responses) f.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", f);
  return f;
}
const urls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => String(c[0]));
const bodies = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => String((c[1] as RequestInit | undefined)?.body ?? ""));

beforeEach(() => {
  vi.stubEnv("META_APP_ID", APP);
  vi.stubEnv("META_APP_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as SystemTokenRefused);

describe("checkSystemToken", () => {
  it("a valid system token: its scopes and active ad accounts; app token only in POST bodies, token never in a URL", async () => {
    const f = stubFetch(json(debug()), json({ data: [ACCOUNT, { ...ACCOUNT, id: "act_2", account_status: 2 }] }));
    expect(await checkSystemToken(TOKEN)).toEqual({ scopes: ["ads_read", "business_management"], accounts: [ACCOUNT] });
    expect(urls(f).join(" ")).not.toContain(TOKEN);
    expect(urls(f).join(" ")).not.toContain(SECRET);
    expect(bodies(f)[0]).toContain(`access_token=${APP}%7C${SECRET}`);
    expect((f.mock.calls[1][1] as RequestInit).headers).toEqual({ authorization: `Bearer ${TOKEN}` });
  });

  it.each([
    ["another app", { app_id: "999" }, SYSTEM_TOKEN_MESSAGES.otherApp],
    ["a user token", { type: "USER" }, SYSTEM_TOKEN_MESSAGES.personal],
    ["an expiring token", { expires_at: 1_900_000_000 }, SYSTEM_TOKEN_MESSAGES.expires],
    ["no ads_read", { scopes: ["business_management"] }, SYSTEM_TOKEN_MESSAGES.noAds],
    ["an invalid token", { is_valid: false }, SYSTEM_TOKEN_MESSAGES.invalid],
  ])("%s → refused with its message", async (_name, extra, message) => {
    stubFetch(json(debug(extra)));
    expect(await refusal(checkSystemToken(TOKEN))).toMatchObject({ status: 422, message });
  });

  it("no ad account → refused", async () => {
    stubFetch(json(debug()), json({ data: [] }));
    expect(await refusal(checkSystemToken(TOKEN))).toMatchObject({ status: 422, message: SYSTEM_TOKEN_MESSAGES.noAccounts });
  });

  it("Graph refuses the POST: the batch fallback keeps the request and app token in the POST body", async () => {
    const f = stubFetch(json({ error: { message: "Unsupported post request" } }, 400), json([{ code: 200, body: JSON.stringify(debug()) }]), json({ data: [ACCOUNT] }));
    expect((await checkSystemToken(TOKEN)).accounts).toEqual([ACCOUNT]);
    expect(urls(f)[1]).toBe("https://graph.facebook.com/v23.0/");
    expect(bodies(f)[1]).toContain(`access_token=${APP}%7C${SECRET}`);
    expect(bodies(f)[1]).toContain("batch=");
    expect(urls(f).join(" ")).not.toMatch(new RegExp(`${TOKEN}|${SECRET}`));
  });

  it("a Graph error whose text contains the token → fixed message; neither the token nor Graph's text is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(json(debug()), json({ error: { message: `Invalid OAuth access token - Cannot parse access token: ${TOKEN}` } }, 400));
    const e = await refusal(checkSystemToken(TOKEN));
    expect(e).toMatchObject({ status: 502, message: SYSTEM_TOKEN_MESSAGES.unreachable });
    expect(JSON.stringify([e?.message, warn.mock.calls])).not.toContain(TOKEN);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Invalid OAuth");
  });

  it("no app id or secret → 503", async () => {
    vi.stubEnv("META_APP_SECRET", "");
    expect(await refusal(checkSystemToken(TOKEN))).toMatchObject({ status: 503 });
  });
});

describe("Meta Ads OAuth adapter", () => {
  it("always sets an expiry (a missing or 0 expires_in is 60 days), so it is never taken for a system token", async () => {
    for (const expires of [undefined, 0]) {
      stubFetch(
        json({ access_token: "short" }),
        json({ access_token: "long", ...(expires === undefined ? {} : { expires_in: expires }) }),
        json({ data: [{ permission: "ads_read", status: "granted" }] }),
        json({ data: [ACCOUNT] }),
      );
      const [a] = await PROVIDERS.META_ADS.exchange({ code: "c", clientId: APP, secret: SECRET, redirectUri: "https://x" });
      expect(a.tokenExpiresAt).toBeInstanceOf(Date);
      expect(a.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);
    }
  });
});
