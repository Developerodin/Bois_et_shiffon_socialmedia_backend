import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: vi.fn(async () => ({ workspaceId: "w1", brandId: "b1" })) }));
vi.mock("@/server/data/channel-analytics", async (orig) => ({
  ...(await orig<object>()),
  channelAnalytics: vi.fn(async (_scope: unknown, channel: string, days: number) => ({ channel, days, state: "not_connected" })),
}));

import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/insights/channel/route";

const call = (q: string) => GET(new Request(`http://x/insights/channel?${q}`), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });

describe("insights/channel route", () => {
  it.each([["pinterest", "pinterest"], ["threads", "threads"], ["meta", "facebook"], ["instagram", "instagram"]])("accepts channel=%s", async (q, channel) => {
    const res = await call(`channel=${q}&days=7`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ channel, days: 7 });
  });

  it.each(["channel=tiktok", "channel=threads&days=31", "channel=pinterest&days=0", "channel=pinterest&days=1.5", "days=7"])("refuses %s", async (q) => {
    expect((await call(q)).status).toBe(422);
  });
});
