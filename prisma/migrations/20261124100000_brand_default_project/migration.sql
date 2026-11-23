-- Every business gets one project named after it (new ones get it in create-brand.ts). Marked by requestId
-- 'brand-default', so the unique (brandId, requestId) makes this safe to re-run. Owner: the person who created the
-- business, from its brand.created audit event, if still known.
INSERT INTO "WorkProject" (id, "workspaceId", "brandId", name, "ownerId", "requestId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, b."workspaceId", b.id, b."displayName",
       (SELECT a."actorUserId" FROM "AuditEvent" a JOIN "User" u ON u.id = a."actorUserId"
        WHERE a."brandId" = b.id AND a.action = 'brand.created' ORDER BY a."createdAt" LIMIT 1),
       'brand-default', now(), now()
FROM "Brand" b
ON CONFLICT ("brandId", "requestId") DO NOTHING;
