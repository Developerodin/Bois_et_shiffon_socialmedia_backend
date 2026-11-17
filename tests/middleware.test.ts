import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ default: () => ({ auth }) }));

import middleware, { config } from "@/middleware";

const req = () => new NextRequest("http://localhost:3101/api/v1/me");
const event = {} as never;

beforeEach(() => {
  auth.mockReset().mockResolvedValue(new Response(null));
  process.env.AUTH_URL = "http://localhost:3100";
  delete process.env.WEB_ORIGINS;
  delete process.env.CSRF_MODE;
});

describe("cross-origin writes", () => {
  const send = (method: string, headers: Record<string, string>, path = "/api/v1/workspaces/w1/brands/b1/photoshoots") =>
    middleware(new NextRequest(`http://localhost:3101${path}`, { method, headers }), event);
  const refused = async (res: Response) => res.status === 403 && ((await res.clone().json()) as { code?: string }).code === "csrf.crossOrigin";

  it.each([
    ["a same-origin browser write", "POST", { "sec-fetch-site": "same-origin" }],
    ["the web's origin through the dev proxy", "POST", { origin: "http://localhost:3100", "sec-fetch-site": "same-origin" }],
    ["the web's own server-side write (Origin only)", "PATCH", { origin: "http://localhost:3100" }],
    ["a phone write with a Bearer token and no Origin", "POST", { authorization: "Bearer x" }],
    ["a read from anywhere", "GET", { origin: "https://evil.example" }],
  ])("lets through %s", async (_, method, headers) => {
    expect(await refused(await send(method, headers))).toBe(false);
    expect(auth).toHaveBeenCalled();
  });

  it("lets a provider's webhook through with no browser headers", async () => {
    expect(await refused(await send("POST", {}, "/api/v1/webhooks/meta"))).toBe(false);
  });

  it.each([
    ["another site's origin", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
    ["a same-site subdomain", { origin: "https://x.localhost:3100", "sec-fetch-site": "same-site" }],
    ["no origin and no fetch metadata", {}],
  ])("refuses a cookie write from %s, before Auth.js runs", async (_, headers) => {
    expect(await refused(await send("POST", headers))).toBe(true);
    expect(auth).not.toHaveBeenCalled();
  });

  it("allows the dev origins listed in WEB_ORIGINS", async () => {
    process.env.WEB_ORIGINS = "http://192.168.0.12:3100, http://127.0.0.1:3100";
    expect(await refused(await send("POST", { origin: "http://127.0.0.1:3100" }))).toBe(false);
  });

  it("only logs in CSRF_MODE=log", async () => {
    process.env.CSRF_MODE = "log";
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await refused(await send("POST", { origin: "https://evil.example" }))).toBe(false);
    expect(log.mock.calls[0][0]).toContain("csrf.crossOrigin");
    log.mockRestore();
  });
});

describe("API middleware", () => {
  it("runs only on /api/v1", () => {
    expect(config.matcher).toEqual(["/api/v1/:path*"]);
  });

  it("copies the rolled session cookie onto the response", async () => {
    const rolled = new Response(null, { headers: { "set-cookie": "authjs.session-token=new; Path=/; HttpOnly" } });
    auth.mockResolvedValue(rolled);
    const res = await middleware(req(), event);
    expect(res.headers.getSetCookie()).toEqual(["authjs.session-token=new; Path=/; HttpOnly"]);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("returns Auth.js's redirect as is", async () => {
    auth.mockResolvedValue(Response.redirect("http://localhost:3100/login", 307));
    const res = await middleware(req(), event);
    expect(res.status).toBe(307);
  });
});
