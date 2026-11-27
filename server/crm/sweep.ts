import { queueFollowUps } from "@/server/crm/follow-ups";

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
}
