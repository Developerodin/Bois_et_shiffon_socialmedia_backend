/** A person as the app names them to the team: their name, else their email's local part (never the whole email). */
export function personName(u: { name: string | null; email: string }) {
  return u.name?.trim() || u.email.split("@")[0]!;
}
