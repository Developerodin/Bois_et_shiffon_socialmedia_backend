import { randomInt, randomUUID } from "node:crypto";
import { putTransient, takeTransient } from "@/server/db/transient";
import { words as wordsOf } from "@/server/reels/recordings";
import { PublishingError } from "@/server/services/publishing";
import { clonePassage } from "@/shared/contract/clone-passages";

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
    while (original.length >= 3 && longestInOrder(round.map((s) => original.indexOf(s))) > Math.ceil(original.length / 2)) round = shuffled(original);
    sentences.push(...round);
  }
  const challengeId = randomUUID();
  const stored: Stored = { userId: scope.userId, workspaceId: scope.workspaceId, lang: passage.lang, text: sentences.join(" ") };
  await putTransient(keyOf(challengeId), stored, CHALLENGE_TTL_MS);
  return { challengeId, lang: passage.lang, sentences };
}

/** Longest run of items still in rising order (not necessarily adjacent): how much of the original order a round keeps. */
function longestInOrder(order: number[]) {
  const tails: number[] = [];
  for (const x of order) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = x;
  }
  return tails.length;
}

/**
 * Whether the transcript reads the challenge in its order: the longest common word sequence covers 80 % of it.
 * saysTheScript ignores order, so on its own an old recording of the passage would pass any later shuffle.
 * ponytail: O(n·m) on ~200 words; a passage with under 3 sentences (Hindi) has too few orders to tell replays apart.
 */
export function readInOrder(challenge: string, transcript: string) {
  const a = wordsOf(challenge);
  const b = wordsOf(transcript);
  if (!a.length || !b.length) return false;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (const w of a) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) row[j] = w === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  return prev[b.length] / a.length >= 0.8;
}

/** Uses up a challenge. Missing, expired, used, or someone else's: the same 410, with no hint which. */
export async function takeChallenge(scope: Scope, challengeId: string) {
  const stored = await takeTransient<Stored>(keyOf(challengeId));
  if (!stored || stored.userId !== scope.userId || stored.workspaceId !== scope.workspaceId) {
    throw new PublishingError("That reading has expired. Start the recording again.", 410, "clone.challengeExpired");
  }
  return { lang: stored.lang, text: stored.text };
}
