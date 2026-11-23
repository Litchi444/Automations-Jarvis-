# H2: Live assistant test
owner: human, then n8n-operator · verify: n8n-operator · previous handoff: plan/handoffs/P4.md
skippable: yes (local mode without a public URL)

## Part A: you, from your phone (the manager shows this list)
1. Text: "What's on my calendar tomorrow?" → text reply
2. Voice: "Did anyone important email me today?" → voice reply
3. Text: "Put a dentist appointment on Thursday at 3pm for one hour" → approval card → tap **✅ Approve** → check Google Calendar
4. Tap **✅ Approve** again on the same card → toast "Already executed"
5. Ask for another suggestion and tap **❌ Decline** → card says Declined

## Part B: n8n-operator verifies (delegated by the manager)
Read only: `scripts/n8n-executions.sh`, `scripts/decision-log.sh`
1. `./scripts/n8n-executions.sh 10`
2. `./scripts/decision-log.sh`

## Acceptance criteria
- [ ] Assistant executions for the test are `success` (no `error`)
- [ ] decision log shows ≥ 1 `executed` and ≥ 1 `declined`
- [ ] No proposal is `executed` twice (one row per card)
- [ ] User confirmed replies 1–2 arrived and the event exists in Google Calendar

If `N8N_API_KEY` isn't set, step B1 prints a skip line. Then rely on the decision log and the user's confirmation.
