CREATE TYPE "public"."message_feedback_rating" AS ENUM('GOOD', 'BAD');--> statement-breakpoint
CREATE TABLE "message_feedbacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"rating" "message_feedback_rating" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_feedbacks" ADD CONSTRAINT "message_feedbacks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_feedbacks_message_id_unique" ON "message_feedbacks" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_feedbacks_rating_created_at_idx" ON "message_feedbacks" USING btree ("rating","created_at");