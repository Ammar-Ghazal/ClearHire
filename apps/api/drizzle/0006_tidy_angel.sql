CREATE TABLE "repository_selections" (
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"position" integer NOT NULL,
	"source" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"pushed_at" timestamp with time zone,
	"assessed_commit" text,
	"assessed_at" timestamp with time zone,
	"assessed_since" timestamp with time zone,
	"legacy_assessment_id" uuid,
	"progress" jsonb,
	"last_error" text,
	"github_failures" integer DEFAULT 0 NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_selections_subject_kind_subject_key_repo_id_pk" PRIMARY KEY("subject_kind","subject_key","repo_id")
);
--> statement-breakpoint
ALTER TABLE "demo_candidates" ADD COLUMN "selection_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_assessments" ADD COLUMN "repo_id" bigint;--> statement-breakpoint
ALTER TABLE "skill_assessments" ADD COLUMN "part" text;--> statement-breakpoint
CREATE INDEX "skill_assessments_repo_idx" ON "skill_assessments" USING btree ("subject_kind","subject_key","repo_id");