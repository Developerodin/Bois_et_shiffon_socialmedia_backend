import { afterEach, describe, expect, it, vi } from "vitest";
import { clientOf, logPaidStart, paidStart, paidStartsPaused } from "@/server/api/client";

const req = (tag?: string) => new Request("http://localhost/x", { headers: tag ? { "x-client": tag } : {} });

afterEach(() => {
  delete process.env.PAID_STARTS_OFF_FOR;
});

describe("client tag", () => {
  it("reads the kind and version", () => {
    expect(clientOf(req("web/1.2.0"))).toEqual({ kind: "web", version: "1.2.0" });
    expect(clientOf(req("mobile/1.0.0"))).toEqual({ kind: "mobile", version: "1.0.0" });
    expect(clientOf(req())).toEqual({ kind: "unknown", version: null });
    expect(clientOf(req("curl/8"))).toEqual({ kind: "unknown", version: null });
  });

  it("tells untagged callers apart by how they sign in: Bearer is the phone, the cookie is the website", () => {
    const bearer = new Request("http://localhost/x", { headers: { authorization: "Bearer t" } });
    const cookie = new Request("http://localhost/x", { headers: { cookie: "authjs.session-token=s" } });
    expect(clientOf(bearer)).toEqual({ kind: "mobile", version: null });
    expect(clientOf(cookie)).toEqual({ kind: "web", version: null });
    process.env.PAID_STARTS_OFF_FOR = "web";
    expect(paidStartsPaused(cookie)?.status).toBe(503);
    expect(paidStartsPaused(bearer)).toBeNull();
  });

  it("pauses paid starts only for the listed clients", async () => {
    expect(paidStartsPaused(req("web/1"))).toBeNull();
    process.env.PAID_STARTS_OFF_FOR = "web";
    const res = paidStartsPaused(req("web/1"));
    expect(res?.status).toBe(503);
    expect(await res?.json()).toMatchObject({ code: "paid.pausedForClient", title: "Making this from the website is paused" });
    expect(paidStartsPaused(req("mobile/1"))).toBeNull();
    expect(paidStartsPaused(req())).toBeNull();
  });

  it("wraps a paid start: paused first, then one log line with the outcome", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const toResponse = (e: unknown) => Response.json({}, { status: (e as { status: number }).status });
    const started = await paidStart(req("web/1"), { feature: "clone", workspaceId: "w1", refId: "r1" }, async () => Response.json({}, { status: 201 }), toResponse);
    expect(started.status).toBe(201);
    await paidStart(req("mobile/2"), { feature: "clone", workspaceId: "w1" }, async () => Promise.reject(Object.assign(new Error("busy"), { status: 409 })), toResponse);
    await paidStart(req(), { feature: "clone", workspaceId: "w1" }, async () => Response.json({}, { status: 200 }), toResponse);
    const lines = log.mock.calls.map(([l]) => JSON.parse(l));
    expect(lines.map((l) => [l.client, l.outcome, l.refId])).toEqual([["web", "started", "r1"], ["mobile", "409", null], ["unknown", "repeated", null]]);
    process.env.PAID_STARTS_OFF_FOR = "web";
    const run = vi.fn();
    expect((await paidStart(req("web/1"), { feature: "clone", workspaceId: "w1" }, run, toResponse)).status).toBe(503);
    expect(run).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("logs one JSON line per paid start", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logPaidStart({ feature: "photoshoot", client: "web", workspaceId: "w1", refId: "r1", outcome: "started", ms: 12 });
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ event: "paid.start", feature: "photoshoot", client: "web", workspaceId: "w1", refId: "r1", outcome: "started", ms: 12 });
    log.mockRestore();
  });
});
