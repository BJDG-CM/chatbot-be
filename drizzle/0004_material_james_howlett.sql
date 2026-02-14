CREATE TYPE "public"."collaborator_role" AS ENUM('VIEWER');--> statement-breakpoint
CREATE TYPE "public"."collaborator_status" AS ENUM('PENDING', 'ACCEPTED');--> statement-breakpoint
CREATE TABLE "widget_key_collaborators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"widget_key_id" uuid NOT NULL,
	"invitee_email" varchar(255) NOT NULL,
	"invitee_idp_uuid" varchar(255),
	"role" "collaborator_role" DEFAULT 'VIEWER' NOT NULL,
	"status" "collaborator_status" DEFAULT 'PENDING' NOT NULL,
	"invited_by_idp_uuid" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "widget_key_collaborators" ADD CONSTRAINT "widget_key_collaborators_widget_key_id_widget_keys_id_fk" FOREIGN KEY ("widget_key_id") REFERENCES "public"."widget_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "widget_key_collaborators_widget_key_id_idx" ON "widget_key_collaborators" USING btree ("widget_key_id");--> statement-breakpoint
CREATE INDEX "widget_key_collaborators_invitee_email_idx" ON "widget_key_collaborators" USING btree ("invitee_email");--> statement-breakpoint
CREATE INDEX "widget_key_collaborators_invitee_idp_uuid_idx" ON "widget_key_collaborators" USING btree ("invitee_idp_uuid");--> statement-breakpoint
CREATE UNIQUE INDEX "widget_key_collaborators_widget_key_id_invitee_email_unique" ON "widget_key_collaborators" USING btree ("widget_key_id","invitee_email");