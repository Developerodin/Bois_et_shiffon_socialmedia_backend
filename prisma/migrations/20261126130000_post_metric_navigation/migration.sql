-- Fail fast instead of queueing metric writes behind a long lock; re-run if it times out.
SET lock_timeout = '5s';

-- AlterTable: nullable, no default, so no table rewrite.
ALTER TABLE "PostMetric" ADD COLUMN     "navigation" INTEGER;
