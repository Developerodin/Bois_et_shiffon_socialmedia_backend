-- A task can be owned by a project role until someone holding it takes it; tasks.all lets someone see and assign
-- every task (without it, people see only the tasks that are theirs: server/tasks/access.ts). Built-in roles are reset
-- to the catalog once (Owner and Admin now take theirs from code), and Commercial owner merges into Manager.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "ownerRoleId" TEXT;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_ownerRoleId_fkey" FOREIGN KEY ("ownerRoleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A person or a role owns a task, never both.
ALTER TABLE "Task" ADD CONSTRAINT "task_one_owner" CHECK (num_nonnulls("ownerId", "ownerRoleId") <= 1);

-- Open tasks by owning role (the mine view and Today), shaped like task_open_owner. Not in schema.prisma (partial).
CREATE INDEX "task_open_owner_role" ON "Task" ("brandId", "ownerRoleId", COALESCE("dueOn", 'infinity'::date), "id")
WHERE status IN ('TODO','IN_PROGRESS','IN_REVIEW');

-- Who holds a role on a brand (the role-owner EXISTS in the visibility rule, and role notices).
CREATE INDEX "BrandMember_brandId_roleId_idx" ON "BrandMember"("brandId", "roleId");

-- Every built-in role row is reset to SYSTEM_ROLES (permissions.catalog.ts) once: the stored copies had drifted (a
-- workspace made by a stale server had no tasks.* keys at all) and no owner had edited a built-in role. This gives
-- Owner, Admin and Project admin tasks.all and Manager commercial.manage. Every workspace gets every built-in role with
-- the catalog's name, description, scope and permissions (a snapshot; the catalog test compares them). A custom role
-- that happens to use a built-in slug is left alone.
INSERT INTO "Role" ("id", "workspaceId", "slug", "name", "description", "isSystem", "scope", "permissions", "createdAt", "updatedAt")
SELECT 'r' || md5(random()::text || w."id" || c.slug), w."id", c.slug, c.name, c.description, true, c.scope::"RoleScope", c.permissions, now(), now()
FROM "Workspace" w CROSS JOIN (VALUES
  ('owner', 'Owner', 'Full control of the workspace and every project, including ownership and billing', 'WORKSPACE', ARRAY['workspace.manage', 'members.read', 'members.manage', 'invitations.manage', 'roles.read', 'roles.manage', 'audit.read', 'brand.create', 'brand.archive', 'voices.manage', 'brand.read', 'project.members.manage', 'agents.read', 'agents.run', 'context.edit', 'context.confirm', 'rules.approve', 'content.create', 'content.approve', 'content.download', 'publish.execute', 'integrations.manage', 'inbox.read', 'analytics.read', 'commercial.manage', 'tasks.read', 'tasks.manage', 'tasks.all']::TEXT[]),
  ('admin', 'Admin', 'Manages people, roles and every project; not ownership', 'WORKSPACE', ARRAY['members.read', 'members.manage', 'invitations.manage', 'roles.read', 'roles.manage', 'audit.read', 'brand.create', 'brand.archive', 'voices.manage', 'brand.read', 'project.members.manage', 'agents.read', 'agents.run', 'context.edit', 'context.confirm', 'rules.approve', 'content.create', 'content.approve', 'content.download', 'publish.execute', 'integrations.manage', 'inbox.read', 'analytics.read', 'commercial.manage', 'tasks.read', 'tasks.manage', 'tasks.all']::TEXT[]),
  ('member', 'Member', 'Sees only the projects they are invited to', 'WORKSPACE', ARRAY[]::TEXT[]),
  ('project-admin', 'Project admin', 'Everything on this project, including who works on it', 'PROJECT', ARRAY['brand.read', 'project.members.manage', 'agents.read', 'agents.run', 'context.edit', 'context.confirm', 'rules.approve', 'content.create', 'content.approve', 'content.download', 'publish.execute', 'integrations.manage', 'inbox.read', 'analytics.read', 'commercial.manage', 'tasks.read', 'tasks.manage', 'tasks.all']::TEXT[]),
  ('manager', 'Manager', 'Runs agents, strategy, the calendar, publishing, product priorities, campaigns and offers', 'PROJECT', ARRAY['brand.read', 'agents.read', 'analytics.read', 'agents.run', 'context.edit', 'context.confirm', 'content.create', 'content.download', 'publish.execute', 'integrations.manage', 'inbox.read', 'commercial.manage', 'tasks.read', 'tasks.manage']::TEXT[]),
  ('creator', 'Creator', 'Writes and edits drafts', 'PROJECT', ARRAY['brand.read', 'agents.read', 'analytics.read', 'content.create', 'tasks.read', 'tasks.manage']::TEXT[]),
  ('approver', 'Approver', 'Reviews posts, brand rules and strategy', 'PROJECT', ARRAY['brand.read', 'agents.read', 'analytics.read', 'context.edit', 'context.confirm', 'rules.approve', 'content.approve', 'content.download', 'inbox.read', 'tasks.read']::TEXT[]),
  ('client-reviewer', 'Client reviewer', 'Sees the work and reports, approves posts and downloads', 'PROJECT', ARRAY['brand.read', 'analytics.read', 'content.approve', 'content.download', 'tasks.read']::TEXT[]),
  ('viewer', 'Viewer', 'Read-only access to this project', 'PROJECT', ARRAY['brand.read', 'agents.read', 'analytics.read', 'tasks.read']::TEXT[])
) AS c(slug, name, description, scope, permissions)
ON CONFLICT ("workspaceId", "slug") DO UPDATE SET
  "name" = EXCLUDED."name", "description" = EXCLUDED."description", "scope" = EXCLUDED."scope",
  "permissions" = EXCLUDED."permissions", "updatedAt" = now()
WHERE "Role"."isSystem";

-- Commercial owner merges into Manager (which now holds commercial.manage): everyone and everything on the built-in
-- commercial-owner role moves to the same workspace's built-in manager role, then the commercial-owner rows go.
UPDATE "BrandMember" bm SET "roleId" = m.id, "updatedAt" = now()
FROM "Role" co JOIN "Role" m ON m."workspaceId" = co."workspaceId" AND m."isSystem" AND m.slug = 'manager'
WHERE bm."roleId" = co.id AND co."isSystem" AND co.slug = 'commercial-owner';

UPDATE "WorkspaceMember" wm SET "roleId" = m.id
FROM "Role" co JOIN "Role" m ON m."workspaceId" = co."workspaceId" AND m."isSystem" AND m.slug = 'manager'
WHERE wm."roleId" = co.id AND co."isSystem" AND co.slug = 'commercial-owner';

UPDATE "Invitation" i SET "roleId" = m.id
FROM "Role" co JOIN "Role" m ON m."workspaceId" = co."workspaceId" AND m."isSystem" AND m.slug = 'manager'
WHERE i."roleId" = co.id AND co."isSystem" AND co.slug = 'commercial-owner';

UPDATE "Task" t SET "ownerRoleId" = m.id
FROM "Role" co JOIN "Role" m ON m."workspaceId" = co."workspaceId" AND m."isSystem" AND m.slug = 'manager'
WHERE t."ownerRoleId" = co.id AND co."isSystem" AND co.slug = 'commercial-owner';

DELETE FROM "Role" co
WHERE co."isSystem" AND co.slug = 'commercial-owner'
  AND NOT EXISTS (SELECT 1 FROM "BrandMember" x WHERE x."roleId" = co.id)
  AND NOT EXISTS (SELECT 1 FROM "WorkspaceMember" x WHERE x."roleId" = co.id)
  AND NOT EXISTS (SELECT 1 FROM "Invitation" x WHERE x."roleId" = co.id);
