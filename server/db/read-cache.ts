import "server-only";
import { dropTransient, getTransient, putTransient } from "@/server/db/transient";

/**
 * A short shared cache for provider reads (inbox, Google): every open of a screen by every client would otherwise be a
 * provider call. Kept in Postgres so all API instances share it. A cache failure never fails the read.
 * ponytail: a write elsewhere (Meta app, Google profile) shows up after the TTL at most; webhooks would make it instant.
 */
export async function cachedRead<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = await getTransient<{ v: T }>(key).catch(() => null);
  if (hit) return hit.v;
  const v = await load();
  await putTransient(key, { v }, ttlMs).catch((e: unknown) => console.error("[read-cache] put", key, e));
  return v;
}

/** Drops cached reads after a write the person will expect to see at once (a reply sent, a post published). */
export async function forgetRead(...keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => dropTransient(k).catch((e: unknown) => console.error("[read-cache] drop", k, e))));
}

export const READ_TTL_MS = 45_000;
export const readKey = {
  inbox: (brandId: string) => `read:inbox:${brandId}`,
  googleReviews: (brandId: string) => `read:google-reviews:${brandId}`,
  googlePosts: (brandId: string) => `read:google-posts:${brandId}`,
};
