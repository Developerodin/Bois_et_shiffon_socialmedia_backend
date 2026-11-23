import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLISHERS } from "@/server/integrations/publishers";

afterEach(() => vi.unstubAllGlobals());

describe("META publisher", () => {
  it("new facebook photo post stores post_id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "photo1", post_id: "page1_post1" }))));
    const res = await PUBLISHERS.META!(
      { text: "hi", title: "", altText: "", link: null, imageUrl: "https://x/a.jpg", imageUrls: [], videoUrl: null, boardId: null },
      { id: "page1", token: "t" },
    );
    expect(res).toEqual({ externalId: "page1_post1", externalUrl: "https://www.facebook.com/photo1" });
  });
});
