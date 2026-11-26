import { randomUUID } from "node:crypto";
import type { IntegrationConnection, IntegrationProvider, Prisma } from "@prisma/client";
import { requireBrandAccess } from "@/server/auth/access";
import { requirePermission } from "@/server/auth/permissions";
import { hashToken, newToken } from "@/server/auth/tokens";
import { currentKeyVersion, decryptCredentials, encryptCredentials } from "@/server/crypto/credentials";
import { prisma } from "@/server/db/prisma";
import { PROVIDERS, ProviderError, providerConfig, type ConnectedAccount, type OAuthProvider } from "@/server/integrations/providers";
import { postedCount, storyTargetOf } from "@/server/services/publishing";
import { askCartConfig } from "@/server/shopify/askcart";
import { catalogMcpProfileUrl, isShopifyMcp } from "@/server/shopify/catalog-mcp";

const STATE_TTL_MS = 10 * 60_000; // DEC-017: ≤10 min

export class ConnectionError extends Error {}
/** The account's access is gone (expired, revoked on the platform): a person must reconnect it. */
export { ReconnectNeeded } from "@/server/services/reconnect-needed";
import { ReconnectNeeded } from "@/server/services/reconnect-needed";

const REFRESH_AHEAD_MS = 3 * 86_400_000;

/** Mark an account as needing reconnect, with a reason people can read in Connections. */
export async function markReconnect(connectionId: string, reason: string) {
  await prisma.integrationConnection.updateMany({
    where: { id: connectionId, status: "ACTIVE" },
    data: { status: "ERROR", lastError: reason.slice(0, 300) },
  });
}

/**
 * A usable access token for this account, refreshed first when it expires within 3 days.
 * A refresh the platform refuses (or an already-expired token) marks the account "Needs reconnect".
 * A network failure while the old token still works just uses the old one; the next call retries.
 * ponytail: two refreshes at once both succeed and the last write wins; the platforms allow it.
 */
export async function accessToken(conn: IntegrationConnection): Promise<string> {
  if (conn.status !== "ACTIVE" || !conn.encryptedCredentials) throw new ReconnectNeeded(`${conn.displayName} isn't connected`);
  const creds = decryptCredentials<ConnectedAccount["credentials"]>(conn.encryptedCredentials);
  const expiresAt = conn.tokenExpiresAt?.getTime();
  // Google access tokens live an hour: refresh just before, not 3 days ahead (that would refresh on every call).
  const ahead = conn.provider === "GOOGLE" || conn.provider === "GOOGLE_BUSINESS" ? 5 * 60_000 : REFRESH_AHEAD_MS;
  // Shopify Admin tokens don't expire and have no refresh.
  if (!expiresAt || expiresAt - Date.now() > ahead || conn.provider === "SHOPIFY") return creds.accessToken;
  const adapter = PROVIDERS[conn.provider];
  // Can't be refreshed (Meta Ads): used until it actually expires, then only a person reconnecting brings it back.
  if (adapter.noRefresh) {
    if (expiresAt > Date.now()) return creds.accessToken;
    await markReconnect(conn.id, `Access expired. Reconnect ${conn.displayName}.`);
    throw new ReconnectNeeded(`${conn.displayName}'s access expired`);
  }
  const cfg = providerConfig(conn.provider);
  const expired = expiresAt <= Date.now();
  try {
    if (!adapter.refresh || !cfg) throw new ProviderError("400 This account can't be refreshed automatically");
    const next = await adapter.refresh({ credentials: creds, ...cfg });
    const keyVersion = currentKeyVersion();
    // Only onto a still-connected account: a Disconnect during the refresh must keep its credentials gone.
    const { count } = await prisma.integrationConnection.updateMany({
      where: { id: conn.id, status: "ACTIVE" },
      data: { encryptedCredentials: encryptCredentials(next.credentials, keyVersion), credentialKeyVersion: keyVersion, tokenExpiresAt: next.tokenExpiresAt, lastError: null },
    });
    if (count !== 1) throw new ReconnectNeeded(`${conn.displayName} isn't connected`);
    return next.credentials.accessToken;
  } catch (e) {
    if (e instanceof ReconnectNeeded) throw e;
    const refused = e instanceof ProviderError && /^4\d\d /.test(e.message);
    // An expired token with a refresh token isn't lost on a network blip: the next call refreshes again.
    if (refused || (expired && !creds.refreshToken)) {
      await markReconnect(conn.id, `Access expired. Reconnect ${conn.displayName}.`);
      throw new ReconnectNeeded(`${conn.displayName}'s access expired`);
    }
    return creds.accessToken;
  }
}

const WARN_AHEAD_MS = 7 * 86_400_000;

/**
 * Daily: refresh every token that expires within 3 days, so posts never meet an expired one. Tokens that can't be
 * refreshed (noRefresh: Meta Ads) get a "Reconnect … before <date>" note from 7 days ahead, status unchanged; once
 * expired, accessToken marks them Needs reconnect (so an ad sync then stops with reason "reconnect", as expected).
 */
export async function refreshExpiringTokens() {
  const now = Date.now();
  const soon = await prisma.integrationConnection.findMany({
    where: { status: "ACTIVE", tokenExpiresAt: { lt: new Date(now + REFRESH_AHEAD_MS) } },
  });
  for (const c of soon) await accessToken(c).catch(() => {});
  const noRefresh = (Object.keys(PROVIDERS) as OAuthProvider[]).filter((p) => PROVIDERS[p].noRefresh);
  const ending = await prisma.integrationConnection.findMany({
    where: { status: "ACTIVE", provider: { in: noRefresh }, tokenExpiresAt: { gt: new Date(now), lt: new Date(now + WARN_AHEAD_MS) } },
    select: { id: true, provider: true, tokenExpiresAt: true },
  });
  for (const c of ending) {
    // Fixed text: the label and a UTC date, nothing from the provider.
    const lastError = `Reconnect ${PROVIDERS[c.provider as OAuthProvider].label} before ${c.tokenExpiresAt!.toISOString().slice(0, 10)}.`;
    await prisma.integrationConnection.updateMany({ where: { id: c.id, status: "ACTIVE" }, data: { lastError } });
  }
}

/** OAuth providers sign in through the platform; Shopify is connected with a pasted Admin API token ("token"). */
export function listProviders() {
  return [
    ...(Object.keys(PROVIDERS) as OAuthProvider[]).map((p) => ({ provider: p, label: PROVIDERS[p].label, configured: providerConfig(p) !== null, kind: "oauth" as const })),
    // askCart: how this deployment can read a store through AskCart: "per-brand" (each brand connects its own store),
    // "single-store" (INTERIM: one store, one brand per deployment) or null (not set up). mcp: Shopify MCP can connect
    // (a public https agent profile URL is set; server/shopify/catalog-mcp.ts).
    { provider: "SHOPIFY" as const, label: "Shopify", configured: true, kind: "token" as const, askCart: askCartConfig()?.mode ?? null, mcp: catalogMcpProfileUrl() !== null },
  ];
}

export const toConnectionDto = (c: IntegrationConnection) => ({
  id: c.id,
  provider: c.provider,
  displayName: c.displayName,
  status: c.status,
  lastError: c.lastError,
  tokenExpiresAt: c.tokenExpiresAt?.toISOString() ?? null,
  connectedAt: c.createdAt.toISOString(),
  // A Shopify store read through the Catalog MCP: products only, no orders.
  ...(c.provider === "SHOPIFY" && isShopifyMcp(c) && { via: "mcp" as const }),
});

export const listConnections = (workspaceId: string, brandId: string) =>
  prisma.integrationConnection.findMany({
    where: { workspaceId, brandId, status: { not: "REVOKED" } },
    orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
  });

/** Step 1: persist a single-use state bound to user + brand + provider (+ where it started), return the consent URL. */
export async function startConnect(input: {
  workspaceId: string;
  brandId: string;
  userId: string;
  provider: OAuthProvider;
  /** "mobile": the callback sends the code back to the app instead of connecting (see the callback route). */
  client?: "web" | "mobile";
}) {
  const cfg = providerConfig(input.provider);
  if (!cfg) throw new ConnectionError(`${PROVIDERS[input.provider].label} isn't set up yet (missing app keys)`);
  return PROVIDERS[input.provider].authorizeUrl({
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    state: await createConnectState(input),
    scope: PROVIDERS[input.provider].scopes.join(","),
  });
}

/**
 * A single-use connect state (DEC-017: only its hash is stored, ≤10 min); returns the raw state for the URL. A PKCE
 * verifier is kept encrypted like a token (it redeems the code), and cleared when the state is used.
 */
export async function createConnectState(input: {
  workspaceId: string; brandId: string; userId: string; provider: IntegrationProvider; client?: "web" | "mobile"; codeVerifier?: string; shop?: string;
}) {
  const { raw, hash } = newToken();
  await prisma.oAuthStateTransaction.create({
    data: { ...input, codeVerifier: input.codeVerifier ? encryptCredentials(input.codeVerifier) : undefined, client: input.client ?? "web", stateHash: hash, expiresAt: new Date(Date.now() + STATE_TTL_MS) },
  });
  return raw;
}

/**
 * Consume the state atomically *before* any code exchange, so a replayed or concurrent callback gets nothing, then
 * re-check access (a role revoked mid-flow must not still connect). A repeat of a callback that already connected
 * returns `replay` instead.
 */
export async function claimConnectState(input: { provider: IntegrationProvider; state: string; userId: string }) {
  const stateHash = hashToken(input.state);
  // The PKCE verifier is read before the consume clears it, so a used state holds none; only the consumer uses it.
  const stored = (await prisma.oAuthStateTransaction.findUnique({ where: { stateHash }, select: { codeVerifier: true } }))?.codeVerifier ?? null;
  // ponytail: a state started before verifiers were encrypted holds it plain; such states live 10 min, then this can go.
  const verifier = stored && stored.startsWith("v1:") ? decryptCredentials<string>(stored) : stored;
  const consumed = await prisma.oAuthStateTransaction.updateMany({
    where: {
      stateHash,
      provider: input.provider,
      userId: input.userId,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { consumedAt: new Date(), codeVerifier: null },
  });
  if (consumed.count !== 1) {
    const replay = await replayedConnect(stateHash, input);
    if (replay) return { replay };
    throw new ConnectionError("This connect link expired or was already used. Try again.");
  }
  const st = { ...(await prisma.oAuthStateTransaction.findUniqueOrThrow({ where: { stateHash } })), codeVerifier: verifier };
  await requireBrandAccess(st.workspaceId, st.brandId, input.userId);
  await requirePermission(st.workspaceId, input.userId, "integrations.manage", st.brandId);
  return { st };
}

/**
 * Step 2 (callback): consume the state atomically *before* the code exchange, so a replayed
 * or concurrent callback gets nothing. Re-checks access at callback time — a role revoked
 * mid-flow must not still connect.
 */
export async function completeConnect(input: {
  provider: OAuthProvider;
  state: string;
  code: string;
  userId: string;
}) {
  const claimed = await claimConnectState(input);
  if (claimed.replay) return claimed.replay;
  const { st } = claimed;

  const cfg = providerConfig(input.provider);
  if (!cfg) throw new ConnectionError("Provider keys were removed during connect");
  const accounts = await PROVIDERS[input.provider].exchange({ code: input.code, ...cfg });

  // A personal Meta Ads login never replaces a working system user token (saveConnections' `keep`).
  const saved = await saveConnections({
    workspaceId: st.workspaceId, brandId: st.brandId, provider: input.provider, userId: input.userId, accounts,
    ...(input.provider === "META_ADS" ? { keep: true as const } : {}),
  });
  return { workspaceId: st.workspaceId, brandId: st.brandId, connections: saved, kept: saved.kept };
}

/**
 * Save connected accounts (tokens encrypted; a reconnect replaces them in place) and the `integration.connected`
 * audit event in one transaction. Used by the OAuth callback and by Shopify's token connect.
 *
 * `keep` (Meta Ads personal logins only): an account already running on a working system user token (ACTIVE, no
 * expiry) is left as it is, unless its META_ADS data source stopped at `permission` or `reconnect` (the system token
 * broke), in which case the login replaces it. Each account is one conditional INSERT … ON CONFLICT … DO UPDATE …
 * WHERE, so a pasted token and a login saving at once can't race past the rule. The returned array is the written
 * rows, as without `keep`, with the kept account ids beside it as `kept`.
 */
export async function saveConnections(input: {
  workspaceId: string; brandId: string; provider: IntegrationProvider; userId: string; accounts: ConnectedAccount[];
  /** Runs first in the same transaction; throw to save nothing (AskCart's one-brand rule). */
  guard?: (tx: Prisma.TransactionClient) => Promise<void>;
  keep?: true;
  /** Merged into the audit event's metadata (the system token path says what it replaced). */
  auditMetadata?: Record<string, unknown>;
  /** Runs last in the same transaction with the written rows (the system token clears its sources' old stops). */
  after?: (tx: Prisma.TransactionClient, rows: IntegrationConnection[]) => Promise<void>;
}): Promise<IntegrationConnection[] & { kept: string[] }> {
  const keyVersion = currentKeyVersion();
  return prisma.$transaction(async (tx) => {
    await input.guard?.(tx);
    if (input.keep) {
      const kept = await saveKeeping(tx, input, keyVersion);
      await input.after?.(tx, kept);
      return kept;
    }
    const rows = [];
    for (const a of input.accounts) {
      const data = {
        displayName: a.displayName,
        scopes: a.scopes,
        encryptedCredentials: encryptCredentials(a.credentials, keyVersion),
        credentialKeyVersion: keyVersion,
        tokenExpiresAt: a.tokenExpiresAt,
        status: "ACTIVE" as const,
        lastError: null,
        connectedByUserId: input.userId,
      };
      rows.push(
        await tx.integrationConnection.upsert({
          where: {
            brandId_provider_externalAccountId: {
              brandId: input.brandId,
              provider: input.provider,
              externalAccountId: a.externalAccountId,
            },
          },
          create: { ...data, workspaceId: input.workspaceId, brandId: input.brandId, provider: input.provider, externalAccountId: a.externalAccountId },
          update: data, // reconnect refreshes tokens in place
        }),
      );
    }
    await tx.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        actorUserId: input.userId,
        action: "integration.connected",
        entityType: "IntegrationConnection",
        entityId: rows[0].id,
        metadata: { provider: input.provider, accounts: rows.map((r) => r.displayName), ...input.auditMetadata },
      },
    });
    await input.after?.(tx, rows);
    return Object.assign(rows, { kept: [] as string[] });
  });
}

/** saveConnections with `keep`: see there. Runs inside its transaction. */
async function saveKeeping(
  tx: Prisma.TransactionClient,
  input: Parameters<typeof saveConnections>[0],
  keyVersion: number,
): Promise<IntegrationConnection[] & { kept: string[] }> {
  const written: string[] = [];
  const kept: string[] = [];
  for (const a of input.accounts) {
    const ids = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "IntegrationConnection" ("id", "workspaceId", "brandId", "provider", "externalAccountId", "displayName", "scopes",
        "encryptedCredentials", "credentialKeyVersion", "tokenExpiresAt", "status", "lastError", "connectedByUserId", "createdAt", "updatedAt")
      VALUES (${randomUUID()}, ${input.workspaceId}, ${input.brandId}, ${input.provider}::"IntegrationProvider", ${a.externalAccountId}, ${a.displayName},
        ${a.scopes}::text[], ${encryptCredentials(a.credentials, keyVersion)}, ${keyVersion}, (${a.tokenExpiresAt}::timestamptz AT TIME ZONE 'UTC'), 'ACTIVE'::"ConnectionStatus", NULL,
        ${input.userId}, now(), now())
      ON CONFLICT ("brandId", "provider", "externalAccountId") DO UPDATE SET
        "displayName" = EXCLUDED."displayName", "scopes" = EXCLUDED."scopes", "encryptedCredentials" = EXCLUDED."encryptedCredentials",
        "credentialKeyVersion" = EXCLUDED."credentialKeyVersion", "tokenExpiresAt" = EXCLUDED."tokenExpiresAt", "status" = EXCLUDED."status",
        "lastError" = NULL, "connectedByUserId" = EXCLUDED."connectedByUserId", "updatedAt" = now()
      WHERE NOT ("IntegrationConnection"."status" = 'ACTIVE' AND "IntegrationConnection"."tokenExpiresAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "DataSource" d WHERE d."connectionId" = "IntegrationConnection"."id" AND d."kind" = 'META_ADS'
                        AND d."lastResult"->>'reason' IN ('permission', 'reconnect')
                        -- Only a stop recorded after this token was saved: an older one is about the token it replaced.
                        AND d."lastResult"->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
                        AND ((d."lastResult"->>'at')::timestamptz AT TIME ZONE 'UTC') > "IntegrationConnection"."updatedAt"))
      RETURNING "id"`;
    if (ids.length) written.push(ids[0].id);
    else kept.push(a.externalAccountId);
  }
  const found = written.length ? await tx.integrationConnection.findMany({ where: { id: { in: written } } }) : [];
  const rows = written.map((id) => found.find((r) => r.id === id)!);
  const keptRows = kept.length
    ? await tx.integrationConnection.findMany({ where: { workspaceId: input.workspaceId, brandId: input.brandId, provider: input.provider, externalAccountId: { in: kept } }, select: { id: true, displayName: true } })
    : [];
  await tx.auditEvent.create({
    data: {
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      actorUserId: input.userId,
      action: "integration.connected",
      entityType: "IntegrationConnection",
      // Every account kept: the audit names the first kept connection, never an empty array's first row.
      entityId: rows[0]?.id ?? keptRows[0].id,
      metadata: { provider: input.provider, accounts: rows.map((r) => r.displayName), ...(kept.length ? { kept: keptRows.map((r) => r.displayName) } : {}), ...input.auditMetadata },
    },
  });
  return Object.assign(rows, { kept });
}

/**
 * Browsers and providers sometimes hit the callback twice (back button, prefetch, a double
 * redirect). The first request consumed the state and connected; the repeat should report the
 * same success, not "already used". Only the same user, the same state, within 2 minutes, and it
 * never issues or touches tokens. Waits briefly in case the first request is still exchanging.
 */
async function replayedConnect(stateHash: string, input: { provider: IntegrationProvider; userId: string }) {
  const st = await prisma.oAuthStateTransaction.findUnique({ where: { stateHash } });
  if (!st?.consumedAt || st.userId !== input.userId || st.provider !== input.provider) return null;
  if (Date.now() - st.consumedAt.getTime() > 2 * 60_000) return null;
  await requireBrandAccess(st.workspaceId, st.brandId, input.userId);
  for (let i = 0; i < 15; i++) {
    const connections = await prisma.integrationConnection.findMany({
      where: { brandId: st.brandId, provider: input.provider, status: "ACTIVE", updatedAt: { gte: st.consumedAt } },
    });
    if (connections.length) return { workspaceId: st.workspaceId, brandId: st.brandId, connections };
    await new Promise((r) => setTimeout(r, 1000)); // ponytail: polls ~15s; the first request's exchange is usually <5s
  }
  return null;
}

/**
 * Disconnect = forget the tokens. Posts scheduled to this account are cancelled now (back to
 * Approved, ready to schedule elsewhere) rather than failing silently at their time.
 * Returns null when there was nothing to disconnect, else how many scheduled posts were cancelled.
 * ponytail: no provider-side revoke call; the user can also remove the app in the platform's settings.
 */
export async function disconnect(input: { workspaceId: string; brandId: string; connectionId: string; userId: string }) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.integrationConnection.updateMany({
      where: { id: input.connectionId, workspaceId: input.workspaceId, brandId: input.brandId, status: { not: "REVOKED" } },
      data: { status: "REVOKED", encryptedCredentials: null },
    });
    if (count === 0) return null;
    const scheduled = await tx.publicationAttempt.findMany({ where: { connectionId: input.connectionId, status: "SCHEDULED" }, select: { id: true, contentItemId: true, target: true } });
    // A story's Post the rest carries frames already out: it goes back to PARTIAL with its item still SCHEDULED (as
    // cancelling it does), not to an approved story whose next schedule would post those frames again.
    const partial = scheduled.filter((a) => postedCount(storyTargetOf(a.target)?.progress ?? []) > 0);
    const plain = scheduled.filter((a) => !partial.includes(a));
    if (partial.length) {
      await tx.publicationAttempt.updateMany({
        where: { id: { in: partial.map((a) => a.id) }, status: "SCHEDULED" },
        data: { status: "PARTIAL", error: "The account was disconnected. Reconnect it, then post the rest or mark the story as done." },
      });
    }
    if (plain.length) {
      await tx.publicationAttempt.updateMany({
        where: { id: { in: plain.map((a) => a.id) }, status: "SCHEDULED" },
        data: { status: "CANCELLED", error: "Cancelled because the account was disconnected. Schedule it again with a connected account." },
      });
      await tx.contentItem.updateMany({ where: { id: { in: plain.map((a) => a.contentItemId) }, status: "SCHEDULED" }, data: { status: "APPROVED" } });
    }
    await tx.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        actorUserId: input.userId,
        action: "integration.disconnected",
        entityType: "IntegrationConnection",
        entityId: input.connectionId,
        metadata: { cancelledPosts: scheduled.length },
      },
    });
    return { cancelled: scheduled.length };
  });
}
