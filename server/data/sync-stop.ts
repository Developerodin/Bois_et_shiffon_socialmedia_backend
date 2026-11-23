/**
 * Why a provider client stopped short. Clients return `{ ...data, stoppedReason?: SyncStop }`; only bugs throw.
 * capped and rate_limited still write what was read and advance; reconnect, failed, permission and missing_scope write
 * nothing. missing_scope (e.g. Shopify without read_orders) never marks the connection for reconnect.
 */
export type SyncStop = "reconnect" | "permission" | "missing_scope" | "rate_limited" | "failed" | "capped";
