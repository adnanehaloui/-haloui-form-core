-- Full-text search over published apps (name weighted highest).
CREATE INDEX IF NOT EXISTS apps_search_idx ON apps USING GIN (
  (setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
   setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
   setweight(to_tsvector('simple', coalesce(category, '')), 'C'))
);
