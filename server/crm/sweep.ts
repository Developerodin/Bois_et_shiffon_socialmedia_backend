import { queueFollowUps } from "@/server/crm/follow-ups";
import { pruneCrm } from "@/server/crm/retention";

/**
 * The CRM's one entry in the daily sweep (server/jobs/runner.ts), so the sweep list gains one item for all of it:
 * follow-up tasks, then retention. Each part is caught on its own; logs carry counts and error names only.
 */
export async function crmDailySweep(now = new Date()) {
  try {
    const made = await queueFollowUps(now);
    if (made) console.log("[crm] follow-up tasks made", made);
  } catch (e) {
    console.error("[crm] follow-ups failed", e instanceof Error ? e.name : "error");
  }
  try {
    const out = await pruneCrm(now);
    if (Object.values(out).some(Boolean)) console.log("[crm] retention", out);
  } catch (e) {
    console.error("[crm] retention failed", e instanceof Error ? e.name : "error");
  }
}
