ALTER TABLE "demo_candidates" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "demo_jobs" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_assessments" ADD COLUMN "input_manifest" jsonb;