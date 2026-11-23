# Tasks: admins see everything and assign; everyone else sees their own; assign to a role

Date: 2026-11-23. Repos: server, web (mobile: shared sync only). Branch `task-assignment` from `reports-bulk-tasks`
(which touches tasks-page.tsx and isn't merged yet).

## Owner decisions (2026-11-23)
1. Owners and admins land on **all open tasks** (Tasks, Website, Performance).
2. Everyone else sees **only their own tasks** (a change to access rules, not just the default view).
3. A task can be **assigned to a whole role** (e.g. Creators); anyone with that role on the business sees it as theirs.
4. Admins assign from the **list**: an owner picker on each row, and select several → "Assign to…".

## Facts from the code
- Roles: workspace (owner, admin, member) + one project role per person per brand (`BrandMember.roleId`: project-admin,
  manager, creator, approver, client-reviewer, commercial-owner, viewer, plus custom roles). Effective perms = union.
- `tasks.read` is held by every project role; `tasks.manage` by manager, creator, commercial-owner, project-admin and
  workspace owner/admin. So "who may manage" ≠ "admin".
- Visibility is one function: `visibleTaskSql(v)` (server/tasks/access.ts), plus `visibleTasksAcrossSql` for
  notifications across brands; staff see the whole brand today, clients get `clientClause`. ~20 call sites
  (list, task, comments, attachments, checklist, batch, from-note, search, notifications, work projects, finding task).
  Any Prisma-`where` visibility check that doesn't go through these must be found and changed too.
- Task: `ownerId`, `reviewerId`, `createdById`, `blockedOnId`, `workProjectId`. Assigning = tasks.manage today, with a
  TASK_ASSIGNED notification to the new owner.

## Design

### D1. New permission `tasks.all` — "See and assign every task"
- Added to shared `PERMISSIONS` (project scope). Owner/admin get it via `ALL`, project-admin via `PROJECT_KEYS`.
  Not given to manager, creator, approver, commercial-owner, viewer, client-reviewer. Custom roles can be granted it in
  the roles editor (existing UI lists every key).
- Existing workspaces: system roles are re-seeded from SYSTEM_ROLES (check how a new key reaches existing system roles;
  if seeding doesn't update them, a data migration adds `tasks.all` to existing owner/admin/project-admin role rows).
- `TaskViewer` gains `all: boolean` and `roleId: string | null` (the person's project role on this brand).

### D2. Visibility without `tasks.all`
A task is visible to a staff member without tasks.all when any of:
`ownerId = me` · `ownerRoleId = my project role on this brand` · `reviewerId = me` · `blockedOnId = me` ·
`createdById = me`. Unassigned tasks (no owner, no role) — including SEO/GEO auto-tasks — are seen only by tasks.all.
Clients keep `clientClause` unchanged (they never have tasks.all).
- Implemented inside `visibleTaskSql` and `visibleTasksAcrossSql` (per brand: tasks.all and role id per brand), so
  every call site follows. Audit every place that reads tasks without them.
- Work projects: project names stay visible to anyone with tasks.read; progress counts and task lists inside count
  only visible tasks (they already go through visibleTaskSql? verify).
- Search, notifications, Today/home counts, bell: only visible tasks.
- A person who loses sight of a task (reassigned away) stops getting it in lists; existing notifications for it are
  hidden by the same rule.

### D3. Owner can be a role: `Task.ownerRoleId`
- New nullable column `ownerRoleId` → Role (onDelete SetNull), index `(brandId, ownerRoleId)`. At most one of
  `ownerId` / `ownerRoleId` is set (DB CHECK constraint + service validation).
- Valid role: same workspace, PROJECT scope, not client-reviewer.
- "Take it": anyone holding that role on the brand may set `ownerId = me` (clears `ownerRoleId`). This is the only
  ownership change a non-tasks.all user can make.
- Notifications: assigning to a role sends TASK_ASSIGNED to every member holding that role on this brand (not the
  actor). ponytail: one row per member; fine for teams of tens.
- `TaskDto` gains `ownerRole: { id, name } | null`. `mine` view = `ownerId = me OR ownerRoleId = my role`.

### D4. Who can assign
- Changing `ownerId` to someone else, or setting `ownerRoleId`, requires `tasks.all` (create, patch, batch, from-note,
  note-to-tasks). Without it: a new task's owner can only be yourself (or unassigned → then only you, as creator, and
  admins see it); you can "Take it" on a role task you hold.
- The 409/IN_REVIEW owner/reviewer rules stay as they are.

### D5. Default view
- No saved choice: tasks.all → `open`; others → `mine`. Website/Performance links already carry `view=open`; for a
  non-tasks.all user, `open` shows only their visible tasks, which is correct.
- Shell/permissions already reach the web (`brandPermissions`); TasksPage needs `perms` (it has them).

### D6. Web
- List row (tasks.all only): owner cell becomes a compact picker — "Unassigned", people, then "Roles" group. Saves via
  PATCH; optimistic with revert on error.
- Multi-select (tasks.all only): a checkbox per row + header checkbox for the loaded rows; a bar "N selected · Assign
  to… · Clear". Uses the existing batch route if it can carry ownerId/ownerRoleId; else extends it. Max 100 ids.
- Board cards and task panel show the role owner ("Creators") and a "Take it" button for holders.
- New task dialog / note-to-tasks: owner picker includes roles (tasks.all only); others see only "Me" / "Unassigned".
- Roles editor: `tasks.all` shows with its label.

### D7. Mobile
Shared sync only (TaskDto, PERMISSIONS). No phone UI.

## Tests
- Unit: visibleTaskSql for all / role / own / client; mine view with role; assign rules (non-all can't assign others,
  can Take it); CHECK constraint on both owners.
- test:db: a creator sees own, role-assigned, reviewer, blocked-on, created tasks, not others' or unassigned; an admin
  sees all; notifications/search/work-project counts follow; role assignment notifies role members; batch assign.
- Web: default view per perms; row picker and bulk bar only with tasks.all.

## Risks / questions for the review
- Is there task visibility outside visibleTaskSql (Prisma `where` in getTask, today counts, overview, automations,
  agents, exports)? Each must follow D2.
- Existing system-role rows in the DB: does anything re-sync permissions, or do we need a data migration?
- Should Manager get tasks.all by default? (Owner said owners/admins; left out.)
- Notification rows already written for tasks a user can no longer see.

## Amendments after the four-lens plan review (these override the design above)

### Access
- A1. **Migration is required** (ensureSystemRoles only refreshes `owner`; seed never runs at deploy): data migration
  appends `tasks.all` to `isSystem` roles with slug in (owner, admin, project-admin), guarded, copying the pattern in
  `20261123052135_phase1_tasks/migration.sql:289-298`. Custom roles do NOT get it: an owner grants it in the roles editor
  (rollout note). test:db: an existing workspace's admin still lists every task.
- A2. `tasks.all` is staff-only: `taskViewer.all = perms.has("tasks.all") && !clientReviewer`; `updateRole` refuses
  `tasks.all` on the client-reviewer role; the client branch of both visibility functions ignores it. Catalog comment
  explains the name ("tasks.all: see and assign every task").
- A3. **Role match in SQL, no roleId on TaskViewer**: one fragment in access.ts
  `ownedBySql(userId, a)` = `a."ownerId" = me OR EXISTS (SELECT 1 FROM "BrandMember" bm WHERE bm."brandId" = a."brandId"
  AND bm."userId" = me AND bm."roleId" = a."ownerRoleId")`.
  Own-clause = `ownedBySql OR reviewerId = me OR blockedOnId = me OR createdById = me`.
  Used by visibleTaskSql (non-all staff), visibleTasksAcrossSql, the `mine` view, and Today's `mine` group (and its
  count). Blockers group stays person-based (ponytail comment). With `all`, visibleTaskSql emits exactly today's SQL.
- A4. `visibleTasksAcrossSql` rewritten per brand: all-brands (tasks.all from workspace role, or from that brand's grant)
  → brand match; other staff brands → own-clause; client brands → clientClause; archived rule kept. Keep the `OFFSET 0`
  fence in notifications/list.ts. test:db: custom workspace role with tasks.read but no tasks.all sees only its own
  notifications.
- A5. Reads outside visibleTaskSql, all fixed:
  - `listProjects` progress → raw SQL `GROUP BY "workProjectId", status` with visibleTaskSql (fix the comment); list and
    detail agree.
  - audit-reports GET `openTasks` → raw SQL with visibleTaskSql.
  - `taskFromFinding`: an existing open task the caller can't see → 409 `task.findingTaken` ("This finding already has a
    task, owned by someone else"), not 404.
  - `createTaskBatch` and `createTask` requestId replay lookups scoped to `createdById = me` and to visible ids.
  - `replaceReviewTasks`: "untouched" also requires `ownerRoleId IS NULL` (both the find and the UPDATE).
  - Daily overdue/re-check notices: ponytail — role tasks get none until someone takes them (comment in daily-tasks.ts).
- A6. Lock first, then check visibility in `runTaskAction` and `lockTaskForEdit` (reassigning now removes visibility).

### Owner can be a role
- A7. `Task.ownerRoleId` → Role(id) onDelete SetNull; CHECK `num_nonnulls("ownerId","ownerRoleId") <= 1`; partial index
  `task_open_owner_role (brandId, ownerRoleId, COALESCE(dueOn,'infinity'), id) WHERE open`; `@@index([brandId, roleId])`
  on BrandMember. Every write that sets one owner clears the other (patch, assign, take).
- A8. Valid role (`checkTaskLinks`, the one check every task write passes): same workspace, PROJECT scope, not a client
  role (`CLIENT_GRANT_WHERE` rule), permissions include `tasks.read`. `deleteRole` refuses while open tasks use the role.
- A9. `TaskDto.ownerRole: { id, name } | null` via `TASK_DTO_INCLUDE`; `ownerRoleId` in TaskInput/MANAGE_PATCH_FIELDS;
  `ownerLabel` (web task-views.ts) shows the role name.
- A10. **Take it** = new task action `take` (shared TASK_ACTIONS, POST tasks/:id, needs tasks.read). ActorRole gains
  `holdsOwnerRole` (from the EXISTS, computed in toTaskDtos/actorRole with one query per page). Under the lock: task
  still has that ownerRoleId and ownerId null (else 409 `task.taken`), caller holds the role on this brand, not a client,
  status open, and owner ≠ reviewer unless sole staff (the patchTask in-review rule). Sets ownerId = me, ownerRoleId null;
  audit; no notification.
- A11. Notifications: one `notifyManyTx(tx, userIds, …)` (createMany, dedupe key kind:user:event, skips actor). Role
  holders read with one `brandMember.findMany({ brandId, roleId, active users })` inside the transaction. One helper
  `assigneesOf(tx, task)` used at every TASK_ASSIGNED site (create, patch, batch, assign). ponytail ceiling comment.

### Who may do what without tasks.all (my call; owner may override)
- A12. Assign rule (in checkTaskLinks): without tasks.all, `ownerId` may only be yourself or null and `ownerRoleId` must
  be absent; with tasks.all anything valid. Assign routes need tasks.manage too (a custom role with tasks.all alone can
  see but not assign — stated in catalog comment).
- A13. Manage rights: `canManage = tasks.all || (tasks.manage && (isOwner || createdByMe))` in actorRole and patchTask.
  Reviewer and blocked-on keep their existing actions. A role task must be taken before it is started.
- A14. Note to tasks: without tasks.all, proposals drop other owners (use the `_v` param) and the batch 403s any other
  owner.
- A15. Accepted share path: setting reviewer/blocked-on to someone shows them the task (by design).

### Bulk assign
- A16. New `POST tasks/assign` `{ ids: 1..100 unique, ownerId | ownerRoleId | null }`, tasks.manage + tasks.all,
  limitTaskWrites. One transaction: lockRow in sorted id order; one visibility query over the ids (all must be visible
  on this brand, else 404); DONE/CANCELLED skipped; assignee validated once; in-review owner≠reviewer rule per row →
  all-or-nothing 409 naming the task; one updateMany for changed rows; createMany audit events; one notifyManyTx.
  Returns `{ tasks: TaskDto[] }` for the changed rows.

### Web
- A17. People + roles loaded once in TasksPage from `GET tasks/people` (extended: `roles` when tasks.all), passed down.
  PersonSelect gains an optional `roles` prop (`<optgroup label="Roles">`, value `role:<id>`) and one helper maps the
  value to `{ownerId}` / `{ownerRoleId}`. Used in the row cell, bulk bar, task panel, new-task dialog, note-to-tasks.
- A18. Row picker + checkboxes + bulk bar only with tasks.all. Optimistic state keyed by task id; one onTasksChanged
  after a save. Task panel owner picker gated on tasks.all; "Take it" comes from actions.
- A19. Default view: `readSaved(raw, perms.includes("tasks.all") ? "open" : "mine")`.
- A20. Mobile: shared sync only; its display helper reads ownerRole (one line).

### Rollout note
- At deploy, Managers/Creators stop seeing unassigned tasks (incl. SEO/GEO auto-tasks) and others' tasks; admins must
  assign them. Custom admin-like roles need tasks.all granted in the roles editor.

## Owner decisions after the roles audit (2026-11-23, override A1 where they overlap)
Audit: 10 built-in roles (3 workspace, 7 project), no custom roles, stored as a copy per workspace (60 rows in dev).
Copies drift: "Harsh's workspace" (created 5 min after the phase-1 migration by a stale server) has no tasks.* keys in
any role, Owner included. No owner has edited a built-in role.

- A21. **Built-in roles take their permissions from code.** One helper `rolePermissions(role)` = `role.isSystem ?
  SYSTEM_ROLES[slug].permissions : role.permissions`, used everywhere a role's stored permissions decide access
  (effectivePermissions, brandGrant/brandAccess, visibleTasksAcrossSql, isClientGrant if it reads permissions, member/role
  listings that show permissions). `updateRole` refuses permission edits on system roles (UI already treats them as
  read-only; to customise, create a custom role). A one-time migration rewrites every system row's `permissions` to the
  code's list (keeps stored data honest for anything reading raw), which also repairs Harsh's workspace. This replaces
  A1's append-only migration; `ensureSystemRoles` keeps creating missing rows and stops special-casing owner.
  ponytail comment: a code change to SYSTEM_ROLES applies to every workspace at once.
- A22. **Commercial owner merges into Manager.** Manager gains `commercial.manage`. Migration: move every BrandMember
  (and any pending invitation / other reference) holding a `commercial-owner` system role to that workspace's `manager`
  role, then delete the `commercial-owner` rows. Remove it from SYSTEM_ROLES and any UI/role lists/tests that name it.
- Manager: tasks.read + tasks.manage, NOT tasks.all (owner confirmed). Viewer: own tasks only (owner confirmed).
- Final task matrix: Owner/Admin/Project admin: read+manage+all · Manager, Creator: read+manage · Approver, Viewer:
  read · Client reviewer: read (client rule). Update `tasks.manage`'s catalog text to "Create tasks and edit your own"
  and `tasks.all` to "See and assign every task".

### A21 revised (owner, 2026-11-23): only Owner and Admin are fixed in code
- `rolePermissions(role)`: `isSystem && slug in (owner, admin)` → SYSTEM_ROLES list from code; every other role (the
  other built-ins included) → its stored `permissions`. Owners can still edit those built-ins (existing rule: only owners
  change a built-in role; Owner and Admin refuse permission edits).
- One-time migration: rewrite every built-in row's `permissions` to the code list (no built-in has been edited in any
  workspace; this repairs the drifted workspace and gives project-admin `tasks.all`, Manager `commercial.manage`).
  After that, new permission keys reach editable built-ins only through their own migration (as today); Owner/Admin
  pick them up automatically.
- `ensureSystemRoles` keeps creating missing rows; its owner special case can go (owner now reads from code).

### A23 (owner, 2026-11-23): no handing out more power than you hold
- Granting a role (addToProject, changeProjectRole, project invitations; changeMemberRole, workspace invitations) needs
  every permission of the target role (rolePermissions) to be in the actor's own effective permissions on that scope
  (project: on that brand; workspace: workspace role). Owners are never blocked. Refusal: 403 "You can't give a role
  with permissions you don't have". Changing your own role up is covered by the same rule.
- Tests: Manager given project.members.manage can't grant Project admin, can grant Creator; Admin can grant Admin;
  workspace custom role with members.manage can't grant Admin.
