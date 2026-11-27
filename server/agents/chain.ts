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
