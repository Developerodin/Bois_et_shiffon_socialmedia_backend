import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/server/reels/join", () => ({ run: m.run }));
vi.mock("@/server/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/storage/media", () => ({ putMedia: vi.fn(), deleteMedia: vi.fn(), mediaKey: vi.fn() }));
vi.mock("node:fs/promises", async (orig) => ({ ...(await orig<object>()), readFile: vi.fn(async () => Buffer.from([0])) }));

import { audioFormat, isWebm, toWav } from "@/server/reels/recordings";

const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 2, 3, 4, 5]);
const m4a = new Uint8Array([0, 0, 0, 0x20, ...Buffer.from("ftypM4A "), 0, 0, 0, 0]);

beforeEach(() => m.run.mockReset().mockResolvedValue(undefined));

describe("recording formats", () => {
  it("sniffs WebM by its magic bytes", () => {
    expect(isWebm(webm)).toBe(true);
    expect(isWebm(m4a)).toBe(false);
    expect(audioFormat(webm)).toBe("matroska");
    expect(audioFormat(m4a)).toBe("mp4");
    expect(audioFormat(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))).toBeNull();
  });

  it("always tells ffmpeg the format and keeps it to local files", async () => {
    await toWav(webm);
    await toWav(m4a);
    const [a, b] = m.run.mock.calls.map(([args]) => args as string[]);
    expect(a.slice(a.indexOf("-f"), a.indexOf("-f") + 2)).toEqual(["-f", "matroska"]);
    expect(b.slice(b.indexOf("-f"), b.indexOf("-f") + 2)).toEqual(["-f", "mp4"]);
    for (const args of [a, b]) expect(args.slice(args.indexOf("-protocol_whitelist"), args.indexOf("-protocol_whitelist") + 2)).toEqual(["-protocol_whitelist", "file"]);
  });

  it("refuses bytes in neither format without running ffmpeg", async () => {
    await expect(toWav(new Uint8Array(20))).rejects.toMatchObject({ status: 400 });
    expect(m.run).not.toHaveBeenCalled();
  });
});
