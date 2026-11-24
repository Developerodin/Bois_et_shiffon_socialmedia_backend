import { beforeEach, describe, expect, it, vi } from "vitest";
import { readUnsubscribeToken, unsubscribeToken } from "@/server/digest/unsubscribe";
import { scrubSent } from "@/server/email/outbox";

const NOW = Date.parse("2026-11-23T08:00:00Z");

beforeEach(() => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
});

describe("digest unsubscribe token", () => {
  it("names the reader it was made for, for at least 90 days", () => {
    const token = unsubscribeToken("u1", "w1", NOW);
    expect(readUnsubscribeToken(token, NOW + 90 * 86_400_000)).toEqual({ userId: "u1", workspaceId: "w1" });
  });

  it("refuses forged, altered, malformed and expired tokens without throwing", () => {
    const token = unsubscribeToken("u1", "w1", NOW);
    const [payload, sig] = token.split(".");
    const other = Buffer.from(`u2|w1|${NOW + 10 ** 10}`).toString("base64url");
    expect(readUnsubscribeToken(`${other}.${sig}`, NOW)).toBeNull();
    expect(readUnsubscribeToken(`${payload}.${sig!.slice(0, -2)}`, NOW)).toBeNull(); // wrong length
    expect(readUnsubscribeToken(`${payload}.${sig}.x`, NOW)).toBeNull();
    expect(readUnsubscribeToken("", NOW)).toBeNull();
    expect(readUnsubscribeToken(null, NOW)).toBeNull();
    expect(readUnsubscribeToken(token, NOW + 181 * 86_400_000)).toBeNull();
  });

  it("a token signed with another credentials key is refused", () => {
    const token = unsubscribeToken("u1", "w1", NOW);
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    expect(readUnsubscribeToken(token, NOW)).toBeNull();
  });
});

describe("scrubSent", () => {
  it("keeps nothing of a digest's body, and scrubs links from the rest as before", () => {
    expect(scrubSent({ ref: "digest:d1", text: "Sales: 3 orders https://x.test/api/v1/digest/unsubscribe?token=t" })).toEqual({ text: "[digest]", html: null });
    expect(scrubSent({ ref: null, text: "Join: https://a.test/invite/abc" })).toEqual({ text: "Join: [link removed after sending]", html: null });
  });
});
