import { describe, expect, it } from "vitest";
import { dueEpisode, followUpKey } from "@/server/crm/follow-up-tasks";
import { normaliseIdentity } from "@/server/crm/identity";

/** Plan 2026-11-27-crm: identity normalisation and when a follow-up task is due. */
describe("normaliseIdentity", () => {
  it("lower-cases emails, keeps + and digits for phones, refuses bad values without repeating them", () => {
    expect(normaliseIdentity("EMAIL", "  Jeanne@Studio.FR ")).toBe("jeanne@studio.fr");
    expect(normaliseIdentity("PHONE", "+33 (0)6 12-34.56/78")).toBe("+330612345678");
    expect(normaliseIdentity("PHONE", "0033 6 12 34 56 78")).toBe("+33612345678");
    expect(normaliseIdentity("PHONE", "06 12 34 56 78")).toBe("0612345678");
    for (const [kind, v] of [["EMAIL", "jeanne at studio"], ["PHONE", "12345"], ["PHONE", "call me 0612"]] as const) {
      const e = (() => {
        try {
          normaliseIdentity(kind, v);
        } catch (err) {
          return err as Error;
        }
      })();
      expect(e?.message).toBeTruthy();
      expect(e!.message).not.toContain(v);
    }
  });
});

describe("dueEpisode", () => {
  const H = 3_600_000;
  const now = new Date("2026-11-27T12:00:00Z");
  const at = (h: number) => new Date(now.getTime() - h * H);
  const base = { closedAt: null, waitingSince: null, episodeAt: null, lastFromCustomer: true, lastMessageAt: at(1) };
  it("a reply is due 24 h after the episode's first message; waiting after 7 days; never when closed", () => {
    expect(dueEpisode({ ...base, episodeAt: at(23) }, now)).toBeNull();
    expect(dueEpisode({ ...base, episodeAt: at(25) }, now)).toEqual({ kind: "reply", at: at(25) });
    expect(dueEpisode({ ...base, waitingSince: at(24 * 6) }, now)).toBeNull();
    expect(dueEpisode({ ...base, waitingSince: at(24 * 8) }, now)).toEqual({ kind: "waiting", at: at(24 * 8) });
    expect(dueEpisode({ ...base, episodeAt: at(48), closedAt: now }, now)).toBeNull();
    expect(followUpKey("c1", at(25))).toBe(`followup:c1:${at(25).getTime()}`);
  });
});
