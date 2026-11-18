import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/api/brand-route", () => ({ authorizeBrandRoute: vi.fn(async () => ({ userId: "u1", workspaceId: "w1", brandId: "b1" })) }));
vi.mock("@/server/reels/voice", async (orig) => ({ ...(await orig<object>()), voiceList: vi.fn(async () => []) }));
vi.mock("@/server/reels/clones", async (orig) => ({ ...(await orig<object>()), canManageVoices: vi.fn(async () => true) }));

import { GET } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/voices/route";
import { CONSENT_TEXT, CONSENT_VERSION } from "@/server/reels/clones";

describe("GET /voices", () => {
  it("says which consent wording the box agrees to", async () => {
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ workspaceId: "w1", brandId: "b1" }) });
    expect(res.status).toBe(200);
    const { cloning } = await res.json();
    expect(cloning.consentVersion).toBe(CONSENT_VERSION);
    expect(cloning.consent).toBe(CONSENT_TEXT);
  });
});
