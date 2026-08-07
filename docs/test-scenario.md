# Concert Operate MCP — End-to-End Test Scenario

A guided prompt-by-prompt walkthrough that exercises the MCP across the full AIOps lifecycle:
event ingestion → alert correlation → story creation → enrichment → resolution.

Run each phase in order inside Bob. The prompts are written so Bob will call the correct MCP tools automatically — you don't need to name tools explicitly.

---

## Prerequisites

- The `concert-operate` MCP server is connected in Bob (check the MCP panel)
- `npm run build` has been run at least once in this repo

---

## Phase 0 — Setup

> Run this once before your first end-to-end test. Enables the policy that promotes
> high-severity alerts into stories, and creates the runbook used to resolve the fault.

### 0a. Enable the story creation policy for high severity alerts

The instance ships with two story creation policies:

| Policy | Default state |
|---|---|
| Default story creation policy for all alerts | disabled |
| **Default story creation policy for high severity alerts** | **disabled** |

For this scenario we use the **high severity** policy (triggers on severity ≥ 5) because it
gives us deliberate control — the Warning (severity 3) event in Phase 1 creates an alert but
does **not** trigger a story, while the two Major (severity 5) events do. This makes the
correlation more interesting to observe.

**Prompt:**
```
Get all policies in Concert Operate. Find the policy named "Default story creation policy for high severity alerts" and enable it.
Confirm its new state.
```

**What to expect:** The policy with ID `8b4a18c0-860a-11f1-acbd-a5ce317e9fa4` returned with
`"state": "enabled"`.

---

### 0b. Create the diagnostic runbook

**Prompt:**
```
Create a runbook in Concert Operate called "Database Node Recovery". It should have the
following manual steps:
1. Check db-node-01 connection pool metrics
2. Restart the connection pool service on db-node-01
3. Verify query latency returns to below 100ms baseline
4. Post a resolution event to clear the alert

Set the description to: "Standard recovery procedure for database connection pool exhaustion."
Show me the runbook ID once created.
```

**What to expect:** A runbook object returned with an `id`. Note this ID — you'll use it in Phase 3.

---

## Phase 1 — Trigger the fault

> Post three escalating events that simulate a database fault propagating up through a service
> dependency. The two Major (severity 5) events will drive story creation via the policy enabled
> in Phase 0a. The initial Warning sets the scene but won't create a story on its own.

### 1a. Initial warning on the database node

**Prompt:**
```
Create an event in Concert Operate with the following details:
- Summary: "Connection pool exhausted on db-node-01"
- Severity: 3 (Warning)
- Resource name: "db-node-01"
- Resource type: "database"
- Sender name: "monitoring-agent"
- Event type: "problem"
- Classification: "Performance"
- Condition: "connection-pool-exhausted"
```

---

### 1b. Escalation to major fault

**Prompt:**
```
Create another event in Concert Operate:
- Summary: "Query latency exceeding SLA threshold on db-node-01"
- Severity: 5 (Major)
- Resource name: "db-node-01"
- Resource type: "database"
- Sender name: "monitoring-agent"
- Event type: "problem"
- Classification: "Performance"
- Condition: "latency"
```

---

### 1c. Upstream service impact

**Prompt:**
```
Create a third event in Concert Operate:
- Summary: "Upstream dependency degraded — payment-service cannot reach db-node-01"
- Severity: 5 (Major)
- Resource name: "payment-service"
- Resource type: "service"
- Sender name: "monitoring-agent"
- Event type: "problem"
- Classification: "Connectivity"
- Condition: "upstream-dependency-degraded"
```

---

## Phase 2 — Observe

> Verify the pipeline fired correctly. Allow 30–60 seconds after Phase 1 for
> correlation to run before executing these prompts.

### 2a. Find the alerts

**Prompt:**
```
Get all alerts in Concert Operate with severity 3 or higher. Show me the id, summary, severity, and state for each one.
```

**What to expect:** Three alerts — one Warning on `db-node-01`, two Major alerts on
`db-node-01` and `payment-service`.

---

### 2b. Inspect the primary alert

**Prompt:**
```
Get the full details of the alert for "db-node-01" with the highest severity. Show all fields.
```

---

### 2c. Check for a story

**Prompt:**
```
Get all incidents in Concert Operate. Show the id, title, state, and how many alerts each incident contains.
```

**What to expect:** Two stories — one grouping the two `db-node-01` Major alerts (I/O
saturation + query latency), and a separate story for the `payment-service` alert. Without
topology data the correlation engine has no edge to traverse between the two resources, so it
correctly keeps them in separate stories. If no stories appear after 60 seconds, confirm the
high severity story creation policy is enabled (Phase 0a).

---

### 2d. Inspect the story timeline

**Prompt:**
```
Get the full details and timeline for the story/incident you just found. Show everything.
```

> 💡 This is a good point to open the Concert Operate UI and explore the story view
> before continuing to Phase 3.

---

## Phase 3 — Enrich

> Add operational context to the alert and story — this is what an on-call engineer
> would do while investigating.

### 3a. Add an investigation comment to the story

**Prompt:**
```
Add a comment to the db-node-01 story/incident saying:
"Investigating: connection pool exhausted, payment-service upstream impact confirmed. Initiating database node recovery runbook."
```

> 💡 Comments added to the **incident** appear in the Notes/Activity tab in the Concert
> Operate UI. Alert-level timeline entries are only visible via the API.

---

### 3b. Attach the runbook to the alert

**Prompt:**
```
Attach the "Database Node Recovery" runbook to the db-node-01 Major alert as a runbook insight.
```

---

### 3c. Update the story with a status comment

**Prompt:**
```
Add a comment to the story saying:
"Root cause identified: db-node-01 connection pool exhaustion. Recovery runbook in progress. ETA to resolution: 15 minutes."
```

---

## Phase 4 — Resolve

> Simulate the fault being fixed. Post a resolution event, close the alerts, and
> mark the story resolved.

### 4a. Post the resolution events

**Prompt:**
```
Create three resolution events in Concert Operate to clear each of the open alerts:

Event 1:
- Summary: "Connection pool restarted — db-node-01 operating normally"
- Severity: 1 (Indeterminate/Clear)
- Resource name: "db-node-01"
- Resource type: "database"
- Sender name: "monitoring-agent"
- Event type: "resolution"
- Classification: "Performance"
- Condition: "connection-pool-exhausted"

Event 2:
- Summary: "Query latency returned to baseline — db-node-01 SLA threshold no longer breached"
- Severity: 1 (Indeterminate/Clear)
- Resource name: "db-node-01"
- Resource type: "database"
- Sender name: "monitoring-agent"
- Event type: "resolution"
- Classification: "Performance"
- Condition: "latency"

Event 3:
- Summary: "payment-service upstream dependency restored — db-node-01 reachable"
- Severity: 1 (Indeterminate/Clear)
- Resource name: "payment-service"
- Resource type: "service"
- Sender name: "monitoring-agent"
- Event type: "resolution"
- Classification: "Connectivity"
- Condition: "upstream-dependency-degraded"
```

> Each resolution event must match the `classification` and `condition` of its corresponding
> problem event exactly — this is what allows the pipeline to deduplicate and auto-close the
> associated alert.
>
> When all member alerts of an incident transition to `clear` or `closed`, Concert Operate
> automatically rolls that state up to the parent incident and marks it as resolved — no
> manual incident update is required. If all three resolution events above are accepted and
> each returns a `related-alert` insight, you should see both incidents disappear from the
> active list within a few seconds as the platform handles full lifecycle resolution end-to-end.

---

### 4b. Verify the full alert timeline

**Prompt:**
```
Get the complete timeline for the db-node-01 Major alert. Show all entries in chronological order.
```

**What to expect:** The full history — creation, comments, insight attachments, and resolution — all in one timeline.

> ⚠️ **The alert may already be gone.** Once resolution events close an alert, the platform
> removes it from the active store and this call will return 404. If that happens, skip this
> step — the pipeline resolved everything automatically. Check the Concert Operate UI for the
> audit trail instead.

> 💡 Good point to return to the Concert Operate UI to see the resolved story and its audit trail.

---

## Phase 5 — Teardown (optional)

> Resets the environment so the scenario can be run again from Phase 1.
> Run this only when you are done exploring the UI.

### 5a. Delete the test runbook

**Prompt:**
```
Delete the "Database Node Recovery" runbook.
```

---

### 5b. Clear all test alerts

**Prompt:**
```
Get all alerts related to "db-node-01" or "payment-service". Bulk-update them all to closed state.
```

---

### 5c. Re-disable the high severity story creation policy

> Restores the policy to its original out-of-box state.

**Prompt:**
```
Find the policy named "Default story creation policy for high severity alerts" and disable it. Confirm its new state.
```

---

### 5d. Confirm clean state

**Prompt:**
```
Get all current alerts and incidents in Concert Operate. Confirm the system is empty and ready for another test run.
```

---

## Policy reference

| Policy name | ID | Out-of-box state | State during scenario |
|---|---|---|---|
| Default story creation policy for all alerts | `8bb3d710-860a-11f1-acbd-a5ce317e9fa4` | disabled | — (leave as-is) |
| Default story creation policy for high severity alerts | `8b4a18c0-860a-11f1-acbd-a5ce317e9fa4` | disabled | **enabled in Phase 0a** |

---

## Quick reference — what each phase exercises

| Phase | Tools used |
|---|---|
| 0a — Policy setup | `get-policies`, `update-policy` |
| 0b — Runbook creation | `create-runbook` |
| 1 — Trigger | `create-event` × 3 |
| 2 — Observe | `get-alerts`, `get-alert`, `get-incidents`, `get-incident`, `get-alert-timeline` |
| 3 — Enrich | `add-incident-comment` × 2, `create-alert-insight` × 2 |
| 4 — Resolve | `create-event` × 3, `get-alert-timeline` |
| 5 — Teardown | `delete-runbook`, `bulk-update-alerts`, `update-policy` |
