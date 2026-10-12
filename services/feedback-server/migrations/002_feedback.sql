-- Anonymous learnings shared between agents. Everything here has been PII-scrubbed twice
-- (client and server). No IPs, user ids or client identifiers are stored.
CREATE TABLE IF NOT EXISTS feedback (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procedure      text NOT NULL,
  administration text,
  region         text,
  kind           text NOT NULL CHECK (kind IN ('tip', 'friction', 'gotcha', 'outcome')),
  title          text NOT NULL,
  body           text NOT NULL,
  tags           text[] NOT NULL DEFAULT '{}',
  urls           text[] NOT NULL DEFAULT '{}',
  outcome        text CHECK (outcome IN ('success', 'partial', 'failure')),
  app_version    text,
  helpful        integer NOT NULL DEFAULT 0 CHECK (helpful >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Weights: title A, procedure + tags B, body C, administration + region D.
  search_es tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('pg_catalog.spanish', title), 'A') ||
    setweight(to_tsvector('pg_catalog.spanish', procedure || ' ' || public.f_array_to_text(tags)), 'B') ||
    setweight(to_tsvector('pg_catalog.spanish', body), 'C') ||
    setweight(to_tsvector('pg_catalog.spanish',
      coalesce(administration, '') || ' ' || coalesce(region, '')), 'D')
  ) STORED,
  search_unaccent tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('public.spanish_unaccent', title), 'A') ||
    setweight(to_tsvector('public.spanish_unaccent', procedure || ' ' || public.f_array_to_text(tags)), 'B') ||
    setweight(to_tsvector('public.spanish_unaccent', body), 'C') ||
    setweight(to_tsvector('public.spanish_unaccent',
      coalesce(administration, '') || ' ' || coalesce(region, '')), 'D')
  ) STORED
);

CREATE INDEX IF NOT EXISTS feedback_search_es_idx ON feedback USING gin (search_es);
CREATE INDEX IF NOT EXISTS feedback_search_unaccent_idx ON feedback USING gin (search_unaccent);
CREATE INDEX IF NOT EXISTS feedback_title_trgm_idx
  ON feedback USING gin (public.f_unaccent(lower(title)) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS feedback_procedure_trgm_idx
  ON feedback USING gin (public.f_unaccent(lower(procedure)) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback (created_at DESC);
