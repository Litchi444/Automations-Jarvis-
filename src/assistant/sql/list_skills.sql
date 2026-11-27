-- Read-only agent tool "Skills: list". $1 optional word to filter on ('' = all skills).
-- strpos instead of LIKE so % and _ typed by the model are plain characters.
SELECT name, description
  FROM assistant.skills
 WHERE btrim($1::text) = ''
    OR strpos(lower(name || ' ' || description), lower(btrim($1::text))) > 0
 ORDER BY name
 LIMIT 50;
