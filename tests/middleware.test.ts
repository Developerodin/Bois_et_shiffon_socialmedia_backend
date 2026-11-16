import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ default: () => ({ auth }) }));

import middleware, { config } from "@/middleware";

const req = () => new NextRequest("http://localhost:3101/api/v1/me");
const event = {} as never;

beforeEach(() => auth.mockReset());

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
