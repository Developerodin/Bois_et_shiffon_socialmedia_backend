import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, { value: unknown; ttl: number }>());
vi.mock("@/server/db/transient", () => ({
  putTransient: vi.fn(async (k: string, value: unknown, ttl: number) => void store.set(k, { value, ttl })),
  takeTransient: vi.fn(async (k: string) => {
    const e = store.get(k);
    store.delete(k);
    return e?.value ?? null;
  }),
}));

import { makeChallenge, readInOrder, takeChallenge } from "@/server/reels/clone-challenge";
import { CLONE_PASSAGES } from "@/shared/contract/clone-passages";

const scope = { workspaceId: "w1", userId: "u1" };
const split = (t: string) => t.split(/(?<=[.!?。！？।])\s*/).filter(Boolean);
const countWords = (s: string[]) => s.join(" ").split(/\s+/).filter(Boolean).length;

beforeEach(() => store.clear());

describe("reading in order", () => {
  it("accepts the challenge read in its order, with a few misheard words", async () => {
    const c = await makeChallenge(scope, "en");
    const text = c.sentences.join(" ");
    const misheard = text.split(" ").map((w, i) => (i % 15 === 0 ? "uh" : w)).join(" ");
    expect(readInOrder(text, misheard)).toBe(true);
  });

  it("refuses an old recording: the same words in another order", async () => {
    const c = await makeChallenge(scope, "en");
    const original = split(CLONE_PASSAGES.en);
    const rounds = c.sentences.length / original.length;
    const replay = Array.from({ length: rounds }, () => CLONE_PASSAGES.en).join(" ");
    expect(readInOrder(c.sentences.join(" "), replay)).toBe(false);
  });
});

describe("clone challenge", () => {
  it("repeats the passage in shuffled rounds to at least 140 words", async () => {
    const original = split(CLONE_PASSAGES.en);
    const c = await makeChallenge(scope, "en");
    expect(c.lang).toBe("en");
    expect(countWords(c.sentences)).toBeGreaterThanOrEqual(140);
    const rounds = c.sentences.length / original.length;
    expect(Number.isInteger(rounds) && rounds >= 2).toBe(true);
    for (let r = 0; r < rounds; r++) {
      const round = c.sentences.slice(r * original.length, (r + 1) * original.length);
      expect([...round].sort()).toEqual([...original].sort());
    }
    expect(c.sentences.slice(0, original.length)).not.toEqual(original);
  });

  it("stores the challenge for ten minutes, bound to the person", async () => {
    const c = await makeChallenge(scope, "fr");
    const e = store.get(`clone-challenge:${c.challengeId}`);
    expect(e?.ttl).toBe(600_000);
    expect(e?.value).toMatchObject({ userId: "u1", workspaceId: "w1", lang: "fr", text: c.sentences.join(" ") });
  });

  it("can be used once, and only by the person it was made for", async () => {
    const c = await makeChallenge(scope, "en");
    await expect(takeChallenge(scope, c.challengeId)).resolves.toMatchObject({ lang: "en" });
    await expect(takeChallenge(scope, c.challengeId)).rejects.toMatchObject({ status: 410, code: "clone.challengeExpired" });
    const d = await makeChallenge(scope, "en");
    await expect(takeChallenge({ workspaceId: "w1", userId: "u2" }, d.challengeId)).rejects.toMatchObject({ status: 410, code: "clone.challengeExpired" });
    const e = await makeChallenge(scope, "en");
    await expect(takeChallenge({ workspaceId: "w2", userId: "u1" }, e.challengeId)).rejects.toMatchObject({ status: 410 });
  });
});
