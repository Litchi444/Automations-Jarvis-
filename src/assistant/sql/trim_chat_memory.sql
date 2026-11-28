-- "Trim chat memory" (assistant), runs before the agent. $1 memory session key, $2 rows the
-- "Chat memory" node loads (2 × contextWindowLength).
-- The memory node loads the last $2 rows as they are. When that cut lands inside a tool
-- exchange, the history opens with a tool call or a tool result, and Gemini refuses the
-- request (400 "function call turn comes immediately after a user turn ..."), so Jarvis
-- stops answering. Deleting the rows before the oldest user message of that window makes
-- the loaded history always open with a user turn. Only rows the agent can no longer see
-- are deleted. Always returns exactly one row.
WITH recent AS (
  SELECT id, message->>'type' AS type
    FROM public.assistant_chat_history
   WHERE session_id = $1::text
   ORDER BY id DESC
   LIMIT $2::int
), cut AS (
  -- No user message in the window at all: drop the whole window too.
  SELECT coalesce(min(id) FILTER (WHERE type = 'human'), max(id) + 1) AS id FROM recent
), gone AS (
  DELETE FROM public.assistant_chat_history h
   USING cut
   WHERE h.session_id = $1::text AND h.id < cut.id
  RETURNING 1
)
SELECT count(*)::int AS trimmed FROM gone;
