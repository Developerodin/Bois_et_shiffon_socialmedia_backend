-- A content workflow pauses for a person to approve its briefs before the Creator starts.
ALTER TYPE "ContentWorkflowStatus" ADD VALUE 'REVIEW_BRIEFS' AFTER 'REVIEW_PLAN';
