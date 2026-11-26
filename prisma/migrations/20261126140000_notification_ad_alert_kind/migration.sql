-- Its own migration: Postgres cannot use an enum value added by ALTER TYPE ... ADD VALUE in the same transaction.
ALTER TYPE "NotificationKind" ADD VALUE 'AD_ALERT';
