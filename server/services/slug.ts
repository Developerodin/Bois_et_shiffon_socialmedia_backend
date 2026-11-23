/** "Bois & Chiffons — Été" → "bois-chiffons-ete": accents dropped, lower-case ascii, other characters to "-", at most `max`. */
export const slugify = (s: string, { max, fallback }: { max: number; fallback: string }) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, max) || fallback;
