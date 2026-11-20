/** What someone without a name is called to people who may not see any part of their email. */
export const TEAM_MEMBER = "A team member";

/**
 * The one rule for naming a person (accounts.ts' workspace-name split is a different purpose): their trimmed name;
 * else their email's local part, only when `reveal` (the caller holds project.members.manage); else "A team member".
 * Never the whole email. Clients only render the name the server sends, so this is the only place it is decided.
 */
export function personName(u: { name: string | null; email: string }, { reveal }: { reveal: boolean }) {
  return u.name?.trim() || (reveal ? u.email.split("@")[0]! : TEAM_MEMBER);
}
