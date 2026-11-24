-- Quote status, expiry and payment reminders run as a data source (server/quotes/status-sync.ts). Its own migration: a new
-- enum value can't be used in the transaction that adds it.
ALTER TYPE "DataSourceKind" ADD VALUE IF NOT EXISTS 'SHOPIFY_QUOTES';
