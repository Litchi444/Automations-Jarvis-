-- Read-only agent tool "Skills: read". $1 skill name from "Skills: list".
SELECT name, description, body
  FROM assistant.skills
 WHERE name = lower(btrim($1::text));
