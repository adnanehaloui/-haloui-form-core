-- Full-text search over published apps (name weighted highest).
CREATE INDEX IF NOT EXISTS apps_search_idx ON apps USING GIN (
  (setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
   setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
   setweight(to_tsvector('simple', coalesce(category, '')), 'C'))
);
--> statement-breakpoint
-- Typo tolerance (pg_trgm is a trusted extension: no superuser needed on PostgreSQL 13+).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS apps_name_trgm_idx ON apps USING GIN (lower(name) gin_trgm_ops);
