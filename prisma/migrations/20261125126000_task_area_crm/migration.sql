-- The CRM task area (customer follow-ups, quote reminders), in its own migration: a new enum value can't be used in
-- the transaction that adds it.
ALTER TYPE "TaskArea" ADD VALUE IF NOT EXISTS 'CRM';
