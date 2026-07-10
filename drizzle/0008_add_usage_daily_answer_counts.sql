ALTER TABLE "usage_daily" ADD COLUMN "total_answers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD COLUMN "bad_answers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_total_answers_non_negative" CHECK ("usage_daily"."total_answers" >= 0);--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_bad_answers_non_negative" CHECK ("usage_daily"."bad_answers" >= 0);--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_bad_answers_lte_total" CHECK ("usage_daily"."bad_answers" <= "usage_daily"."total_answers");