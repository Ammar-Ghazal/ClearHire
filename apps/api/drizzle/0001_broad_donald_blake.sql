CREATE TABLE "job_priority_overrides" (
	"job_key" text NOT NULL,
	"skill_id" text NOT NULL,
	"priority" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_priority_overrides_job_key_skill_id_pk" PRIMARY KEY("job_key","skill_id"),
	CONSTRAINT "job_priority_overrides_priority_range" CHECK ("job_priority_overrides"."priority" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "muse_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"model" text NOT NULL,
	"attempt" integer NOT NULL,
	"scopes" jsonb NOT NULL,
	"settlement" text NOT NULL,
	"cost_source" text,
	"reserved_micro_usd" bigint NOT NULL,
	"cost_micro_usd" bigint,
	"http_status" integer,
	"finish_reason" text,
	"prompt_tokens" integer,
	"cached_tokens" integer,
	"completion_tokens" integer,
	"reasoning_tokens" integer,
	"latency_ms" integer,
	"response_id" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "muse_spend_budgets" (
	"scope" text PRIMARY KEY NOT NULL,
	"cap_micro_usd" bigint NOT NULL,
	"reserved_micro_usd" bigint DEFAULT 0 NOT NULL,
	"spent_micro_usd" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "muse_spend_budgets_nonnegative" CHECK ("muse_spend_budgets"."reserved_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "skill_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"cache_key" text NOT NULL,
	"model" text NOT NULL,
	"catalogue_version" integer NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"raw_output" jsonb,
	"evidence" jsonb,
	"result" jsonb,
	"verifier_version" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "muse_calls" ADD CONSTRAINT "muse_calls_assessment_id_skill_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."skill_assessments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "muse_calls_assessment_id_idx" ON "muse_calls" USING btree ("assessment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_assessments_cache_key_key" ON "skill_assessments" USING btree ("cache_key");--> statement-breakpoint
CREATE INDEX "skill_assessments_subject_idx" ON "skill_assessments" USING btree ("kind","subject_kind","subject_key","model");