CREATE TABLE "demo_candidates" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"github_url" text NOT NULL,
	"github_login" text NOT NULL,
	"organization" boolean DEFAULT false NOT NULL,
	"repositories" jsonb NOT NULL,
	"verification" jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	"profile_sha256" text NOT NULL,
	"resume_url" text,
	"resume_type" text,
	"resume_source" jsonb,
	"resume_pdf_sha256" text,
	"resume_status" text DEFAULT 'none' NOT NULL,
	"resume_review_reason" text,
	"resume_pages" integer,
	"resume_text" text,
	"prepared" jsonb,
	"prepared_sha256" text,
	"run_id" uuid,
	"run_status" text DEFAULT 'idle' NOT NULL,
	"run_error" text,
	"run_heartbeat_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_employers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"url" text NOT NULL,
	"raw" jsonb NOT NULL,
	"record_sha256" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"employer_id" text NOT NULL,
	"title" text NOT NULL,
	"location" text,
	"source_url" text NOT NULL,
	"source_checked" text,
	"scenario" text NOT NULL,
	"in_scope" boolean NOT NULL,
	"text" text NOT NULL,
	"text_source" text NOT NULL,
	"raw" jsonb NOT NULL,
	"record_sha256" text NOT NULL,
	"input_sha256" text NOT NULL,
	"run_id" uuid,
	"run_status" text DEFAULT 'idle' NOT NULL,
	"run_error" text,
	"run_heartbeat_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demo_jobs" ADD CONSTRAINT "demo_jobs_employer_id_demo_employers_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."demo_employers"("id") ON DELETE no action ON UPDATE no action;