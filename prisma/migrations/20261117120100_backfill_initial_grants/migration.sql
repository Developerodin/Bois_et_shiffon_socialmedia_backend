-- Starter credits for every workspace that hasn't had them yet: balance reads no longer write the grant.
INSERT INTO "CreditEntry" ("id", "workspaceId", "delta", "reason", "refId", "createdAt")
SELECT gen_random_uuid()::text, w."id", 20, 'initial-grant', 'initial', now()
FROM "Workspace" w
ON CONFLICT ("workspaceId", "reason", "refId") DO NOTHING;
