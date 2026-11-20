-- Client reviewer role (snapshot of SYSTEM_ROLES in permissions.catalog.ts), the new keys inbox.read and
-- content.download, and agents.read for custom roles (the assistant and Translate now need it). Every append is
-- guarded, so running it on a workspace that already has a key changes nothing.

-- 1. A custom role that happens to use the slug keeps working under another slug; the slug belongs to the system role.
UPDATE "Role" SET "slug" = 'client-reviewer-custom', "updatedAt" = now()
WHERE "slug" = 'client-reviewer' AND NOT "isSystem";

-- 2. Customer messages and reviews: the roles that answer customers. Owner too: existing Owner rows only track the
--    catalog when ensureSystemRoles runs (the seed), so they get the key here like the others.
UPDATE "Role" SET "permissions" = array_append("permissions", 'inbox.read'), "updatedAt" = now()
WHERE "isSystem" AND "slug" IN ('owner', 'admin', 'project-admin', 'manager', 'approver') AND NOT ('inbox.read' = ANY("permissions"));

UPDATE "Role" SET "permissions" = array_append("permissions", 'inbox.read'), "updatedAt" = now()
WHERE NOT "isSystem" AND 'publish.execute' = ANY("permissions") AND NOT ('inbox.read' = ANY("permissions"));

-- 3. Downloads: whoever publishes or approves.
UPDATE "Role" SET "permissions" = array_append("permissions", 'content.download'), "updatedAt" = now()
WHERE ('publish.execute' = ANY("permissions") OR 'content.approve' = ANY("permissions")) AND NOT ('content.download' = ANY("permissions"));

-- 4. Custom roles that could open the brand keep the assistant and Translate (now behind agents.read).
UPDATE "Role" SET "permissions" = array_append("permissions", 'agents.read'), "updatedAt" = now()
WHERE NOT "isSystem" AND 'brand.read' = ANY("permissions") AND NOT ('agents.read' = ANY("permissions"));

-- 5. The "Client reviewer" project role for every existing workspace.
INSERT INTO "Role" ("id", "workspaceId", "slug", "name", "description", "isSystem", "scope", "permissions", "createdAt", "updatedAt")
SELECT 'r' || md5(random()::text || w."id" || 'client-reviewer'), w."id", 'client-reviewer', 'Client reviewer',
  'Sees the work and reports, approves posts and downloads', true, 'PROJECT'::"RoleScope",
  ARRAY['brand.read', 'analytics.read', 'content.approve', 'content.download']::TEXT[], now(), now()
FROM "Workspace" w
ON CONFLICT ("workspaceId", "slug") DO UPDATE SET
  "name" = EXCLUDED."name", "description" = EXCLUDED."description", "isSystem" = true,
  "scope" = EXCLUDED."scope", "permissions" = EXCLUDED."permissions", "updatedAt" = now();
