-- Its own migration: Postgres cannot use an enum value added by ALTER TYPE ... ADD VALUE in the same transaction.
ALTER TYPE "AdPlatform" ADD VALUE 'GOOGLE';
