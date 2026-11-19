import type { CaptionCue } from "@/shared";
import type { ReelScene } from "@/server/reels/plan";

/** One cue per scene over its span (the spans run back to back); a scene with no voice text has no cue but keeps its time. */
export function captionCues(scenes: readonly Pick<ReelScene, "voiceText">[], seconds: readonly number[]): CaptionCue[] {
  let start = 0;
  return scenes.flatMap((s, i) => {
    const end = start + (seconds[i] ?? 0);
    const text = s.voiceText.trim();
    const cue = text ? [{ start, end, text }] : [];
    start = end;
    return cue;
  });
}
