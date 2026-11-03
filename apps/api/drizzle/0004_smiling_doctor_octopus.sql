DROP INDEX "skill_assessments_cache_key_key";--> statement-breakpoint
ALTER TABLE "demo_jobs" ADD COLUMN "retrieved_on" text;--> statement-breakpoint
ALTER TABLE "demo_jobs" ADD COLUMN "source_limitations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "skill_assessments_cache_key_idx" ON "skill_assessments" USING btree ("cache_key");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_assessments_pending_key" ON "skill_assessments" USING btree ("kind","subject_kind","subject_key") WHERE "skill_assessments"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "demo_candidates" DROP COLUMN "prepared";--> statement-breakpoint
ALTER TABLE "demo_candidates" DROP COLUMN "prepared_sha256";--> statement-breakpoint
ALTER TABLE "skill_assessments" DROP COLUMN "raw_output";--> statement-breakpoint
ALTER TABLE "skill_assessments" DROP COLUMN "evidence";