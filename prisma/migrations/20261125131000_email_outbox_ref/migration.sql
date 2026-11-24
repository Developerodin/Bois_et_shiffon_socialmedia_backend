-- What an outbox email is about ("digest:<digestId>"): the send path rebuilds a digest email from its Digest row.
ALTER TABLE "EmailOutbox" ADD COLUMN "ref" TEXT;
