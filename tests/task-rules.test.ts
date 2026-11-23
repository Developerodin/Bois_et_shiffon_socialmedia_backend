import { describe, expect, it } from "vitest";
import { allowedActions, applyAction, MANAGE_PATCH_FIELDS, pickPatch, type ActorRole, type TaskRow } from "@/shared";

const task = (o: Partial<TaskRow> = {}): TaskRow => ({
  status: "IN_PROGRESS", reviewerId: null, ownerId: "o", ownerRoleId: null, url: null, blockedReason: null, blockedOnId: null,
  completedAt: null, checkedLiveAt: null, checkedLiveById: null, findingClearedAt: null, recheckOn: null, ...o,
});
const owner: ActorRole = { userId: "o", isOwner: true, isReviewer: false, canManage: false, soleStaff: false, isBlockedOn: false, holdsOwnerRole: false };
const reviewer: ActorRole = { userId: "r", isOwner: false, isReviewer: true, canManage: false, soleStaff: false, isBlockedOn: false, holdsOwnerRole: false };
const manager: ActorRole = { userId: "m", isOwner: false, isReviewer: false, canManage: true, soleStaff: false, isBlockedOn: false, holdsOwnerRole: false };
const now = "2026-11-23T10:00:00.000Z";

describe("task rules", () => {
  it("reviewed task finishes only by approve", () => {
    const t = task({ reviewerId: "r" });
    expect(applyAction(t, "markDone", owner, { now })).toMatchObject({ ok: false });
    expect(applyAction(task({ status: "IN_REVIEW", reviewerId: "r" }), "approve", reviewer, { now })).toMatchObject({ ok: true, patch: { status: "DONE" } });
  });
  it("markDone without reviewer → DONE with completedAt", () => {
    expect(applyAction(task(), "markDone", owner, { now })).toEqual({ ok: true, patch: expect.objectContaining({ status: "DONE", completedAt: now }) });
  });
  it("IN_REVIEW leaves only by approve, requestChanges, cancel", () => {
    const t = task({ status: "IN_REVIEW", reviewerId: "r" });
    const all = ["start", "submitForReview", "markDone", "unblock", "checkedLive", "reopen"] as const;
    for (const a of all) expect(applyAction(t, a, manager, { now, reviewerId: "r", reason: "x" })).toMatchObject({ ok: false });
    expect(applyAction(t, "cancel", manager, { now })).toMatchObject({ ok: true, patch: { status: "CANCELLED" } });
    expect(applyAction(t, "requestChanges", reviewer, { now, reason: "fix" })).toMatchObject({ ok: true, patch: { status: "IN_PROGRESS" } });
  });
  it("requestChanges needs a reason", () => {
    const t = task({ status: "IN_REVIEW", reviewerId: "r" });
    expect(applyAction(t, "requestChanges", reviewer, { now })).toMatchObject({ ok: false });
    expect(applyAction(t, "requestChanges", reviewer, { now, reason: "  " })).toMatchObject({ ok: false });
  });
  it("only the reviewer approves", () => {
    const t = task({ status: "IN_REVIEW", reviewerId: "r" });
    expect(applyAction(t, "approve", owner, { now })).toMatchObject({ ok: false });
    expect(applyAction(t, "approve", manager, { now })).toMatchObject({ ok: false });
  });
  it("self-review only when sole staff", () => {
    expect(applyAction(task(), "submitForReview", owner, { now, reviewerId: "o" })).toMatchObject({ ok: false });
    expect(applyAction(task(), "submitForReview", owner, { now })).toMatchObject({ ok: false });
    expect(applyAction(task(), "submitForReview", { ...owner, soleStaff: true }, { now, reviewerId: "o" })).toMatchObject({ ok: true, patch: { status: "IN_REVIEW", reviewerId: "o" } });
    expect(applyAction(task(), "submitForReview", owner, { now, reviewerId: "r" })).toMatchObject({ ok: true, patch: { status: "IN_REVIEW", reviewerId: "r" } });
  });
  it("block records who it waits on", () => {
    expect(applyAction(task(), "block", owner, { now, reason: "waiting", blockedOnId: "x" })).toMatchObject({ ok: true, patch: { blockedReason: "waiting", blockedOnId: "x" } });
  });
  it("blocked-on person may unblock", () => {
    const t = task({ blockedReason: "wait", blockedOnId: "x" });
    const other: ActorRole = { userId: "x", isOwner: false, isReviewer: false, canManage: false, soleStaff: false, isBlockedOn: true, holdsOwnerRole: false };
    expect(applyAction(t, "unblock", other, { now })).toMatchObject({ ok: true });
    expect(allowedActions(t, other)).toEqual(["unblock"]);
    expect(applyAction(t, "unblock", { ...other, isBlockedOn: false }, { now })).toMatchObject({ ok: false });
  });
  it("take: a role holder makes a role's task theirs, once", () => {
    const roleTask = task({ ownerId: null, ownerRoleId: "creators", status: "TODO" });
    const holder: ActorRole = { userId: "h", isOwner: false, isReviewer: false, canManage: false, soleStaff: false, isBlockedOn: false, holdsOwnerRole: true };
    expect(applyAction(roleTask, "take", holder, { now })).toEqual({ ok: true, patch: { ownerId: "h", ownerRoleId: null } });
    expect(allowedActions(roleTask, holder)).toEqual(["take"]);
    expect(applyAction(roleTask, "take", { ...holder, holdsOwnerRole: false }, { now })).toMatchObject({ ok: false });
    expect(applyAction(roleTask, "take", manager, { now })).toMatchObject({ ok: false });
    expect(applyAction(task(), "take", holder, { now })).toMatchObject({ ok: false, code: "task.taken" });
    expect(applyAction({ ...roleTask, status: "DONE" }, "take", holder, { now })).toMatchObject({ ok: false });
  });
  it("take: the reviewer of a task in review can't own it, unless sole staff", () => {
    const inReview = task({ ownerId: null, ownerRoleId: "creators", status: "IN_REVIEW", reviewerId: "h" });
    const holder: ActorRole = { userId: "h", isOwner: false, isReviewer: true, canManage: false, soleStaff: false, isBlockedOn: false, holdsOwnerRole: true };
    expect(applyAction(inReview, "take", holder, { now })).toMatchObject({ ok: false, code: "task.reviewerIsOwner" });
    expect(applyAction(inReview, "take", { ...holder, soleStaff: true }, { now })).toMatchObject({ ok: true });
  });
  it("close clears blocked", () => {
    const t = task({ blockedReason: "wait", blockedOnId: "x" });
    for (const a of ["markDone", "cancel"] as const) {
      const r = applyAction(t, a, manager, { now });
      expect(r).toMatchObject({ ok: true, patch: { blockedReason: null, blockedOnId: null } });
    }
  });
  it("reopen clears finding and live marks", () => {
    const t = task({ status: "DONE", completedAt: now, checkedLiveAt: now, checkedLiveById: "o", findingClearedAt: now, recheckOn: "2026-12-01" });
    expect(applyAction(t, "reopen", owner, { now })).toEqual({
      ok: true,
      patch: { status: "TODO", completedAt: null, checkedLiveAt: null, checkedLiveById: null, findingClearedAt: null, recheckOn: null },
    });
  });
  it("pickPatch drops status and server-only fields", () => {
    const out = pickPatch({ title: "t", status: "DONE", completedAt: "x", checkedLiveAt: "x", auditReportId: "a", createdById: "c", requestId: "r", dueOn: "2026-12-01" });
    expect(out).toEqual({ title: "t", dueOn: "2026-12-01" });
    expect(MANAGE_PATCH_FIELDS).toContain("reviewerId");
  });
  it("allowedActions for reviewer of IN_REVIEW is approve, requestChanges", () => {
    expect(allowedActions(task({ status: "IN_REVIEW", reviewerId: "r" }), reviewer)).toEqual(["approve", "requestChanges"]);
  });
});
