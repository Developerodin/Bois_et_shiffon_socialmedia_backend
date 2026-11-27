import { ContentChannel } from "@prisma/client";
import { z } from "zod";
import { HAND_CHANNELS } from "@/server/agents/prompts/content";

// No INSTAGRAM_REEL: a planned reel would have a script but no video to post. Reels are made in the app's Studio.
// Stories are planned: the Creator writes their frames from the brand's photos (paid by the Planner's own charge).
export const PLANNER_CHANNELS = ["INSTAGRAM_POST", "INSTAGRAM_CAROUSEL", "FACEBOOK_POST", "PINTEREST_PIN", "THREADS_POST", "INSTAGRAM_STORY"] as const;
// HAND_CHANNELS (LinkedIn and X) are posted by hand; the Planner offers them only with PLANNER_HAND_CHANNELS=on, turned on
// once the phone build that names them is released. Posts on them (made by hand, publishing, limits) work either way.
export const handChannelsOn = () => process.env.PLANNER_HAND_CHANNELS === "on";
/** The channels the Planner can plan on now. */
export const plannableChannels = (hand = handChannelsOn()): readonly string[] => (hand ? [...PLANNER_CHANNELS, ...HAND_CHANNELS] : PLANNER_CHANNELS);

/**
 * The posts chain ("Generate calendar"): Brief writer and Creator work in batches (8 and 5 per run), so each starts
 * its next round while posts are still waiting. ponytail: at most this many rounds per stage per Generate (about 48
 * briefs, 30 drafts); a bigger calendar finishes on the next Generate.
 */
export const CHAIN_ROUNDS = 6;

/**
 * The Planner started by a person runs the posts chain (Planner → Brief writer → Creator → Quality) unless the request
 * says chain: false: the phone's Generate calendar and the web already ask for it, the Overview's Run didn't and stopped
 * after planning. Same input for every caller, so two people starting it fold into one run. Other agents: as sent.
 */
export function runInput(agentKey: string, input: unknown): unknown {
  if (agentKey !== "planner") return input;
  if (input === undefined || input === null) return { chain: true };
  if (typeof input !== "object" || Array.isArray(input)) return input; // the schema refuses it
  return { chain: true, ...input };
}

/**
 * The channels a scoped Plan ("Plan with agents") is limited to. The Planner passes them down the chain so the Brief
 * writer and Creator work only on posts on those channels; absent = every channel, as before.
 */
export const chainChannels = z.array(z.nativeEnum(ContentChannel)).min(1).max(9).transform((c) => [...new Set(c)]).optional();
