import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appUrl } from "@/server/auth/tokens";
import { subKey } from "@/server/crypto/credentials";
import { prisma } from "@/server/db/prisma";

/**
 * The digest email's one-click unsubscribe link (RFC 8058): `base64url(userId|workspaceId|exp).hmac`, signed with an
 * HKDF sub-key of the credentials key, valid 180 days (a link in an old email keeps working for months). It only ever
 * turns the email off, so a leaked link can do no more than that. ponytail: rotating the credentials key voids every
 * link sent before; people then turn the email off from the account menu.
 */
const VALID_MS = 180 * 86_400_000;
const mac = (payload: string) => createHmac("sha256", subKey("digest-unsubscribe")).update(payload).digest("base64url");

export function unsubscribeToken(userId: string, workspaceId: string, now = Date.now()) {
  const payload = Buffer.from(`${userId}|${workspaceId}|${now + VALID_MS}`).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

/** The reader a token names, or null for anything forged, malformed or expired (callers answer 400 with no detail). */
export function readUnsubscribeToken(token: string | null, now = Date.now()): { userId: string; workspaceId: string } | null {
  if (!token || token.length > 400) return null;
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const given = Buffer.from(sig);
  const want = Buffer.from(mac(payload));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  const [userId, workspaceId, exp] = Buffer.from(payload, "base64url").toString().split("|");
  if (!userId || !workspaceId || !(Number(exp) > now)) return null;
  return { userId, workspaceId };
}

export const unsubscribeUrl = (userId: string, workspaceId: string) => appUrl(`/api/v1/digest/unsubscribe?token=${unsubscribeToken(userId, workspaceId)}`);

/** Turn the digest email off (one setting per person, every workspace). */
export const stopDigestEmail = (userId: string) => prisma.user.updateMany({ where: { id: userId }, data: { digestEmail: false } });
