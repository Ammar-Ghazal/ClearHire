CREATE TABLE "demo_interview_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_key" text NOT NULL,
	"job_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_interviews" (
	"candidate_key" text NOT NULL,
	"job_id" text NOT NULL,
	"format" text NOT NULL,
	"length_minutes" integer NOT NULL,
	"location" text NOT NULL,
	"confirmed_slot_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_interviews_candidate_key_job_id_pk" PRIMARY KEY("candidate_key","job_id")
);
--> statement-breakpoint
CREATE TABLE "demo_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_key" text NOT NULL,
	"job_id" text NOT NULL,
	"author_side" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_key" text NOT NULL,
	"job_id" text NOT NULL,
	"role" text NOT NULL,
	"base_salary_cad" integer NOT NULL,
	"start_date" date NOT NULL,
	"arrangement" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_preferences" (
	"candidate_key" text PRIMARY KEY NOT NULL,
	"titles" jsonb NOT NULL,
	"locations" jsonb NOT NULL,
	"arrangements" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_relationships" (
	"candidate_key" text NOT NULL,
	"job_id" text NOT NULL,
	"candidate_answer" text,
	"employer_answer" text,
	"candidate_confirmed_at" timestamp with time zone,
	"employer_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_relationships_candidate_key_job_id_pk" PRIMARY KEY("candidate_key","job_id")
);
--> statement-breakpoint
ALTER TABLE "demo_employers" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "demo_interview_slots" ADD CONSTRAINT "demo_interview_slots_candidate_key_job_id_demo_interviews_candidate_key_job_id_fk" FOREIGN KEY ("candidate_key","job_id") REFERENCES "public"."demo_interviews"("candidate_key","job_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_interviews" ADD CONSTRAINT "demo_interviews_candidate_key_job_id_demo_relationships_candidate_key_job_id_fk" FOREIGN KEY ("candidate_key","job_id") REFERENCES "public"."demo_relationships"("candidate_key","job_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_messages" ADD CONSTRAINT "demo_messages_candidate_key_job_id_demo_relationships_candidate_key_job_id_fk" FOREIGN KEY ("candidate_key","job_id") REFERENCES "public"."demo_relationships"("candidate_key","job_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_offers" ADD CONSTRAINT "demo_offers_candidate_key_job_id_demo_relationships_candidate_key_job_id_fk" FOREIGN KEY ("candidate_key","job_id") REFERENCES "public"."demo_relationships"("candidate_key","job_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_preferences" ADD CONSTRAINT "demo_preferences_candidate_key_demo_candidates_key_fk" FOREIGN KEY ("candidate_key") REFERENCES "public"."demo_candidates"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_relationships" ADD CONSTRAINT "demo_relationships_candidate_key_demo_candidates_key_fk" FOREIGN KEY ("candidate_key") REFERENCES "public"."demo_candidates"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_relationships" ADD CONSTRAINT "demo_relationships_job_id_demo_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."demo_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demo_messages_relationship_idx" ON "demo_messages" USING btree ("candidate_key","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_offers_relationship_key" ON "demo_offers" USING btree ("candidate_key","job_id");