import { z } from "zod";
import { isHiddenName, TEAM_MEMBER } from "@/server/content/person-name";
import { PublishingError } from "@/server/services/publishing";

export const STORY_LIMITS = { frames: [3, 5], maxFrames: 5, label: 30, headline: 60, body: 120, cta: 40, composition: 100, clipSeconds: 15, link: 2000 } as const;
/** Instagram's cap on a story frame's file (photo or clip). */
export const FRAME_MAX_BYTES = 8 * 1024 * 1024;
/** The shortest clip window worth rendering: a start this close to the clip's end is refused. */
export const MIN_CLIP_SECONDS = 0.5;
/** The brand logo burned into frames. */
export const LOGO_MAX_BYTES = 5 * 1024 * 1024;

export type SourceRef = { kind: "upload" | "library" | "product" | "post" | "photoshoot" | "reel"; id: string };
export type StoryFrameInput = {
  source?: SourceRef; label: string; headline: string; body: string; composition?: string;
  crop?: { x: number; y: number; scale: number }; clip?: { start: number; sound: boolean };
};
export type FrameFile = { width: number; height: number; bytes: number; durationSec?: number };
export type StoryFrame = StoryFrameInput & {
  mediaKey?: string; mediaKind?: "photo" | "video"; renderedKey?: string; aiMark?: boolean;
  rights?: { kind: "owned" } | { kind: "confirmed"; by: string; name: string }; file?: FrameFile;
};
/** Every finished reel is fitted to 1080×1920 (reels/join.ts). */
export const REEL_SIZE = { width: 1080, height: 1920 } as const;
export type StoryBody = { frames: StoryFrame[]; cta: string; link: string; hook: string; productIds: string[]; brandMark: boolean };
export type StoryInput = { frames: StoryFrameInput[]; cta: string; link: string; brandMark: boolean };

// Only the client-settable fields are listed; .strip() drops mediaKey, renderedKey, aiMark, rights, file.
const frameSchema = z.object({
  source: z.object({ kind: z.enum(["upload", "library", "product", "post", "photoshoot", "reel"]), id: z.string().min(1).max(200) }).strip().optional(),
  label: z.string().max(STORY_LIMITS.label),
  headline: z.string().max(STORY_LIMITS.headline),
  body: z.string().max(STORY_LIMITS.body),
  composition: z.string().max(STORY_LIMITS.composition).optional(),
  crop: z.object({ x: z.number().finite(), y: z.number().finite(), scale: z.number().finite().positive() }).strip().optional(),
  clip: z.object({ start: z.number().finite().min(0), sound: z.boolean() }).strip().optional(),
}).strip();

const httpsLink = z.string().max(STORY_LIMITS.link).refine((v) => {
  if (v === "") return true;
  try { return new URL(v).protocol === "https:"; } catch { return false; }
}, "link must be an https URL");

const inputSchema = z.object({
  frames: z.array(frameSchema).max(STORY_LIMITS.maxFrames),
  cta: z.string().max(STORY_LIMITS.cta),
  link: httpsLink,
  brandMark: z.boolean(),
}).strip();

export function parseStoryInput(raw: unknown): StoryInput {
  const r = inputSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new PublishingError(`${i.path.join(".") || "story"}: ${i.message}`, 400, "story.invalid");
  }
  return r.data as StoryInput;
}

export function storySlides(body: Pick<StoryBody, "frames" | "cta">): string[] {
  const frames = body.frames.map((f) => [f.label, f.headline, f.body].filter(Boolean).join("\n"));
  return [...frames, body.cta].filter(Boolean);
}

/** The story check row that says who confirmed each frame's rights (stories/checks.ts). */
export const ASSET_RIGHTS = "Asset rights";

/** TEAM_MEMBER inside a sentence ("Confirmed by a team member"). */
const MID_SENTENCE_TEAM_MEMBER = TEAM_MEMBER.toLowerCase();

type Rights = { kind: string; by?: string; name?: string };

/**
 * The "Asset rights" pass note's parts, one per frame ("Frame 2: Confirmed by Ana"), null for a frame without rights.
 * `nameOf` names who confirmed; whatever it returns, anything that looks like an email reads as "a team member".
 */
export function rightsLines(frames: { rights?: Rights }[], nameOf: (r: Rights) => string | undefined) {
  return frames.map((f, i) => {
    const r = f.rights;
    if (!r) return null;
    const name = nameOf(r)?.trim();
    // ponytail: "Confirmed by X; …" is the note format both here and in revealRightsNote's regex: change them together.
    const who = r.kind === "owned" ? "Brand's own" : `Confirmed by ${isHiddenName(name) ? MID_SENTENCE_TEAM_MEMBER : name}`;
    return `Frame ${i + 1}: ${who}`;
  });
}

/**
 * A check's rows with the "Asset rights" pass note reworded so who confirmed reads "a team member": for people without
 * project.members.manage, and for the AI. `body` is the checked version's. Other rows, and non-story checks, as they are.
 */
export function hideRightsNote<R>(results: R, body: unknown): R {
  if (!Array.isArray(results)) return results;
  const note = isStoryBody(body) ? rightsLines(body.frames, () => undefined).join("; ") : null;
  return results.map((r: { check?: unknown; status?: unknown; note?: unknown }) => {
    if (r?.check !== ASSET_RIGHTS || r.status !== "pass") return r;
    if (note !== null) return { ...r, note };
    // Not a story body (nothing to rebuild from): reword only the names that hold an email.
    return typeof r.note === "string" && r.note.includes("@")
      ? { ...r, note: r.note.replace(/Confirmed by ([^;]+)/g, (m, n: string) => (n.includes("@") ? `Confirmed by ${MID_SENTENCE_TEAM_MEMBER}` : m)) }
      : r;
  }) as R;
}

/**
 * A story body without who confirmed each frame's rights (`by`, `name`; the kind stays): what people without
 * project.members.manage, and the AI, get. A copy: stored version bodies are never rewritten (packageHash covers them).
 * Anything that isn't a story body comes back as it is.
 */
export function hideRightsNames<T>(body: T): T {
  if (!isStoryBody(body)) return body;
  return { ...body, frames: body.frames.map(({ rights, ...f }) => ({ ...f, rights: rights && { kind: rights.kind } })) } as T;
}

/** An older body or note may hold a whole email as the name: only its local part goes out, to anyone (API_CONTRACTS: the whole email is never returned). */
const localPart = (name: string) => (name.includes("@") ? name.split("@")[0]!.trim() || MID_SENTENCE_TEAM_MEMBER : name);

/** What people who manage members get of a story body: as stored, except a rights name that is an email shows its local part. A copy. */
export function revealRightsNames<T>(body: T): T {
  if (!isStoryBody(body)) return body;
  return { ...body, frames: body.frames.map((f) => (f.rights?.kind === "confirmed" ? { ...f, rights: { ...f.rights, name: typeof f.rights.name === "string" ? localPart(f.rights.name) : TEAM_MEMBER } } : f)) } as T;
}

/** The same for a check's "Asset rights" pass note: "Confirmed by ana@x.com" reads "Confirmed by ana". */
export function revealRightsNote<R>(results: R): R {
  if (!Array.isArray(results)) return results;
  return results.map((r: { check?: unknown; status?: unknown; note?: unknown }) =>
    r?.check === ASSET_RIGHTS && r.status === "pass" && typeof r.note === "string" ? { ...r, note: r.note.replace(/Confirmed by ([^;]+)/g, (_m, n: string) => `Confirmed by ${localPart(n.trim())}`) } : r) as R;
}

export function isStoryBody(x: unknown): x is StoryBody {
  if (!x || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return Array.isArray(b.frames) && typeof b.cta === "string" && typeof b.link === "string" && typeof b.hook === "string"
    && Array.isArray(b.productIds) && typeof b.brandMark === "boolean";
}
