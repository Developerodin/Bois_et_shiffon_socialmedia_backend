import { randomInt, randomUUID } from "node:crypto";
import { putTransient, takeTransient } from "@/server/db/transient";
import { PublishingError } from "@/server/services/publishing";
import { clonePassage } from "@/shared";

/**
 * The voice-clone challenge: the clone passage in the person's language, its sentences shuffled afresh per attempt and
 * repeated in a second (differently shuffled) round, so a recording made earlier can't be replayed. Two rounds also
 * fill the 60–90 s a clone needs (one passage is 57–98 words, about 25–40 s). Single use, 10 minutes, bound to the
 * person and workspace that asked for it.
 */
export const CHALLENGE_TTL_MS = 600_000;
const MIN_WORDS = 140;

type Scope = { workspaceId: string; userId: string };
type Stored = { userId: string; workspaceId: string; lang: string; text: string };
const keyOf = (id: string) => `clone-challenge:${id}`;

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function makeChallenge(scope: Scope, lang: string) {
  const passage = clonePassage(lang);
  const original = passage.text.split(/(?<=[.!?。！？।])\s*/).filter(Boolean);
  const words = (s: string[]) => s.join(" ").split(/\s+/).filter(Boolean).length;
  const sentences: string[] = [];
  while (sentences.length < original.length * 2 || words(sentences) < MIN_WORDS) {
    let round = shuffled(original);
    // A round in the passage's own order is what an old recording says; with under 3 sentences there are too few orders to avoid it.
    while (original.length >= 3 && round.every((s, i) => s === original[i])) round = shuffled(original);
    sentences.push(...round);
  }
  const challengeId = randomUUID();
  const stored: Stored = { userId: scope.userId, workspaceId: scope.workspaceId, lang: passage.lang, text: sentences.join(" ") };
  await putTransient(keyOf(challengeId), stored, CHALLENGE_TTL_MS);
  return { challengeId, lang: passage.lang, sentences };
}

/** Uses up a challenge. Missing, expired, used, or someone else's: the same 410, with no hint which. */
export async function takeChallenge(scope: Scope, challengeId: string) {
  const stored = await takeTransient<Stored>(keyOf(challengeId));
  if (!stored || stored.userId !== scope.userId || stored.workspaceId !== scope.workspaceId) {
    throw new PublishingError("That reading has expired. Start the recording again.", 410, "clone.challengeExpired");
  }
  return { lang: stored.lang, text: stored.text };
}
