/**
 * Why a data client stopped before reading everything. Clients return `{ …data, stoppedReason?: SyncStop }`; only bugs
 * throw. `capped` and `rate_limited` still write what was read and advance the cursor (the next run carries on from
 * there); `reconnect`, `failed`, `permission` and `missing_scope` write nothing.
 * - reconnect: the token was refused; the connection needs reconnecting.
 * - permission: the account can't see this resource any more; the connection itself is fine.
 * - missing_scope: the token works but lacks a scope this read needs; other features on the connection keep working.
 * - rate_limited: the provider asked us to slow down.
 * - failed: the provider errored or didn't answer (5xx, network, timeout).
 * - capped: our own page or time cap ended the run.
 */
export type SyncStop = "reconnect" | "permission" | "missing_scope" | "rate_limited" | "failed" | "capped";
