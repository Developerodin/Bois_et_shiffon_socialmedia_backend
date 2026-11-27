import type { IdentityKind } from "@/shared";
import { CRM_LIMITS } from "@/shared";
import { invalid } from "@/server/crm/common";

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * An identity value as stored: emails lower-cased; phones as "+" and digits when given with a leading "+" (or "00"),
 * else digits only, 6–15 digits; channel ids trimmed. A bad value is refused with a fixed message that never repeats it.
 * ponytail: no country inference for local numbers ("06 12…" stays "0612…"); a libphonenumber pass when it matters.
 */
export function normaliseIdentity(kind: IdentityKind, raw: string): string {
  const v = raw.trim();
  if (!v || v.length > CRM_LIMITS.identity) throw invalid("That contact detail is empty or too long", "crm.identity");
  if (kind === "EMAIL") {
    if (!EMAIL.test(v)) throw invalid("That email address doesn't look right", "crm.identity");
    return v.toLowerCase();
  }
  if (kind === "PHONE") {
    if (/[^\d\s()+.\-/]/.test(v)) throw invalid("A phone number has digits, spaces and + ( ) - . / only", "crm.identity");
    const international = v.startsWith("+") || v.startsWith("00");
    const digits = v.replace(/\D/g, "").replace(/^00/, "");
    if (digits.length < 6 || digits.length > 15) throw invalid("A phone number has 6 to 15 digits", "crm.identity");
    return international ? `+${digits}` : digits;
  }
  if (/\s/.test(v)) throw invalid("That id can't contain spaces", "crm.identity");
  return v;
}
