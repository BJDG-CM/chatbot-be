CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_title_trgm_idx" ON "documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_summary_trgm_idx" ON "documents" USING gin ("summary" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_chunks_path_trgm_idx" ON "document_chunks" USING gin ("path" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_chunks_description_trgm_idx" ON "document_chunks" USING gin ("description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_chunks_content_trgm_idx" ON "document_chunks" USING gin ("content" gin_trgm_ops);
