-- Full-text search for Spanish: accent-insensitive config + trigram similarity.
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- spanish_unaccent = unaccent -> spanish_stem. Snowball needs the accents for some suffixes
-- ("renovación" stems to "renov" but "renovacion" stays "renovacion"), so we index and query
-- BOTH this config and pg_catalog.spanish.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'spanish_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION public.spanish_unaccent (COPY = pg_catalog.spanish);
    ALTER TEXT SEARCH CONFIGURATION public.spanish_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH public.unaccent, pg_catalog.spanish_stem;
  END IF;
END
$$;

-- IMMUTABLE wrappers so they can be used in indexes and generated columns.
CREATE OR REPLACE FUNCTION public.f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN public.unaccent('public.unaccent'::regdictionary, $1);

CREATE OR REPLACE FUNCTION public.f_array_to_text(text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN coalesce(array_to_string($1, ' '), '');
