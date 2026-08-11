#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as https from "https";

// ---------------------------------------------------------------------------
// Configuration (from environment variables)
// ---------------------------------------------------------------------------

const BASE_URL = process.env.CONCERT_BASE_URL;
const CPD_USER = process.env.CONCERT_CPD_USER;
const CPD_PASSWORD = process.env.CONCERT_CPD_PASSWORD;
const CPD_API_KEY = process.env.CONCERT_CPD_API_KEY;
// Default is the product-standard tenant ID that ships with every Concert Operate install.
// Override via CONCERT_TENANT_ID only if your instance uses a different value.
const TENANT_ID = process.env.CONCERT_TENANT_ID ?? "cfd95b7e-3bc7-4006-a4a8-a73a79c71255";

if (!BASE_URL || !CPD_USER || (!CPD_PASSWORD && !CPD_API_KEY)) {
  console.error(
    "ERROR: CONCERT_BASE_URL and CONCERT_CPD_USER must be set, along with either CONCERT_CPD_PASSWORD or CONCERT_CPD_API_KEY."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Token cache + auto-refresh
//
// Concert Operate runs on Cloud Pak for Data with a self-signed cert on the
// TechZone lab instance. We use a permissive HTTPS agent so the Node TLS
// stack does not reject the cert (same behaviour as -k / --insecure in curl).
// ---------------------------------------------------------------------------

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

let cachedToken: string | null = null;
let tokenExpiresAt: number = 0; // epoch ms

async function fetchToken(): Promise<string> {
  const url = `${BASE_URL}/icp4d-api/v1/authorize`;
  const body = CPD_API_KEY
    ? JSON.stringify({ username: CPD_USER, api_key: CPD_API_KEY })
    : JSON.stringify({ username: CPD_USER, password: CPD_PASSWORD });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    // @ts-expect-error — Node 18 fetch accepts this non-standard option
    agent: insecureAgent,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CPD auth failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { token: string; _messageCode_?: string };
  if (!data.token) {
    throw new Error(`CPD auth response missing token: ${JSON.stringify(data).slice(0, 200)}`);
  }

  // CPD tokens are valid for ~12 hours; refresh proactively at 11 h 45 min.
  tokenExpiresAt = Date.now() + 11 * 60 * 60 * 1000 + 45 * 60 * 1000;
  console.error(`[concert-operate] Token acquired, valid until ${new Date(tokenExpiresAt).toISOString()}`);
  return data.token;
}

async function getToken(): Promise<string> {
  if (!cachedToken || Date.now() >= tokenExpiresAt) {
    cachedToken = await fetchToken();
  }
  return cachedToken;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function apiRequest(
  method: string,
  path: string,
  body?: unknown,
  queryParams?: Record<string, string | boolean | number | undefined>
): Promise<unknown> {
  let url = `${BASE_URL}${path}`;

  if (queryParams) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== "") {
        params.set(k, String(v));
      }
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const token = await getToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "x-tenant-id": TENANT_ID!,
  };

  let res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // @ts-expect-error — Node 18 fetch accepts this non-standard option
    agent: insecureAgent,
  });

  // If the token expired mid-session, force-refresh once and retry.
  if (res.status === 401) {
    console.error("[concert-operate] 401 received — refreshing token and retrying");
    cachedToken = null;
    const freshToken = await getToken();
    headers.Authorization = `Bearer ${freshToken}`;
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // @ts-expect-error — Node 18 fetch accepts this non-standard option
      agent: insecureAgent,
    });
  }

  const text = await res.text();
  if (!text) return { status: res.status };

  try {
    return JSON.parse(text);
  } catch {
    return { status: res.status, body: text };
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "concert-operate",
  version: "0.1.0",
});

// ===========================================================================
// EVENTS
// ===========================================================================

server.tool(
  "create-event",
  "Create a new event in Concert Operate.",
  {
    event: z
      .record(z.unknown())
      .describe(
        "Event payload object. Must include at minimum: summary (string), severity (1-6), sender.name, resource.name, resource.type. occurrenceTime (ISO 8601) is injected automatically if omitted."
      ),
    wait_for_commit: z
      .boolean()
      .optional()
      .describe(
        "If true, waits until the event is committed before responding."
      ),
  },
  async ({ event, wait_for_commit }) => {
    try {
      const payload = {
        occurrenceTime: new Date().toISOString(),
        ...event,
      };
      const data = await apiRequest("POST", "/aiops/api/v2/events", payload, {
        wait_for_commit,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: String(e) }],
        isError: true,
      };
    }
  }
);

// ===========================================================================
// ALERTS
// ===========================================================================

server.tool(
  "create-alert",
  "Create a new alert in Concert Operate.",
  {
    alert: z
      .record(z.unknown())
      .describe(
        "Alert payload. Required fields include summary (string), severity (1-6), resource (object with name/type)."
      ),
    wait_for_commit: z.boolean().optional(),
  },
  async ({ alert, wait_for_commit }) => {
    try {
      const data = await apiRequest("POST", "/aiops/api/v2/alerts", alert, {
        wait_for_commit,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-alerts",
  "Retrieve all alerts, optionally filtered. Severity values: 6=Critical, 5=Major, 4=Minor, 3=Warning, 2=Information, 1=Indeterminate.",
  {
    filter: z
      .string()
      .optional()
      .describe(
        'Filter expression, e.g. "severity = 6 or severity = 5". Leave empty for all alerts.'
      ),
    saved_filter: z
      .string()
      .optional()
      .describe("ID of a saved filter to apply."),
    fields: z
      .string()
      .optional()
      .describe(
        'Comma-separated field list, e.g. "id,severity,summary,state". Leave empty for all fields.'
      ),
  },
  async ({ filter, saved_filter, fields }) => {
    try {
      const data = await apiRequest("GET", "/aiops/api/v2/alerts", undefined, {
        filter,
        saved_filter,
        fields,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-alert",
  "Get a single alert by its ID.",
  {
    alert_id: z.string().describe("The unique identifier of the alert."),
    fields: z.string().optional().describe("Comma-separated list of fields to return."),
  },
  async ({ alert_id, fields }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/alerts/${alert_id}`,
        undefined,
        { fields }
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "update-alert",
  "Update specific fields of an alert by ID.",
  {
    alert_id: z.string().describe("The unique identifier of the alert."),
    updates: z
      .record(z.unknown())
      .describe("Partial alert object with the fields to update."),
    wait_for_commit: z.boolean().optional(),
  },
  async ({ alert_id, updates, wait_for_commit }) => {
    try {
      const data = await apiRequest(
        "PATCH",
        `/aiops/api/v2/alerts/${alert_id}`,
        updates,
        { wait_for_commit }
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "bulk-update-alerts",
  "Bulk-update all alerts matching a filter expression.",
  {
    filter: z
      .string()
      .describe(
        'Filter clause identifying which alerts to update, e.g. "severity = 4".'
      ),
    updates: z
      .record(z.unknown())
      .describe("Partial alert object with the fields to update."),
  },
  async ({ filter, updates }) => {
    try {
      const data = await apiRequest(
        "PATCH",
        "/aiops/api/v2/alerts",
        updates,
        { filter }
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-alert-timeline",
  "Get all timeline entries for an alert.",
  {
    alert_id: z.string().describe("The unique identifier of the alert."),
  },
  async ({ alert_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/alerts/${alert_id}/timeline-entries`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "add-alert-comment",
  "Add a comment (timeline entry) to an alert.",
  {
    alert_id: z.string().describe("The unique identifier of the alert."),
    text: z.string().describe("Comment text to add to the alert timeline."),
  },
  async ({ alert_id, text }) => {
    try {
      const data = await apiRequest(
        "POST",
        `/aiops/api/v2/alerts/${alert_id}/timeline-entries`,
        { type: "comment", comment: text }
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-alert-insights",
  "Retrieve all insights for an alert, optionally filtered by insight type.",
  {
    alert_id: z.string().describe("The unique identifier of the alert."),
    type: z
      .string()
      .optional()
      .describe(
        'Insight type to filter by, e.g. "aiops.ibm.com/insight-type/probable-cause".'
      ),
  },
  async ({ alert_id, type }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/alerts/${alert_id}/insights`,
        undefined,
        { type }
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "create-alert-insight",
  "Add a new insight to an alert.",
  {
    alert_id: z.string().describe("The unique identifier of the alert."),
    insight: z.record(z.unknown()).describe("Insight object to add."),
    wait_for_commit: z.boolean().optional(),
  },
  async ({ alert_id, insight, wait_for_commit }) => {
    try {
      const data = await apiRequest(
        "POST",
        `/aiops/api/v2/alerts/${alert_id}/insights`,
        insight,
        { wait_for_commit }
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-alert-insight",
  "Get a specific insight on an alert by insight ID and type.",
  {
    alert_id: z.string(),
    insight_id: z.string(),
    insight_type: z.string().describe('e.g. "aiops.ibm.com/insight-type/runbook"'),
  },
  async ({ alert_id, insight_id, insight_type }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/alerts/${alert_id}/insights/${insight_id}/types/${encodeURIComponent(insight_type)}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "delete-alert-insight",
  "Delete a specific insight from an alert.",
  {
    alert_id: z.string(),
    insight_id: z.string(),
    insight_type: z.string(),
  },
  async ({ alert_id, insight_id, insight_type }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        `/aiops/api/v2/alerts/${alert_id}/insights/${insight_id}/types/${encodeURIComponent(insight_type)}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// ===========================================================================
// INCIDENTS
// ===========================================================================

server.tool(
  "get-incidents",
  "Retrieve all incidents.",
  {},
  async () => {
    try {
      const data = await apiRequest("GET", "/aiops/api/v2/incidents");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-incident",
  "Get a single incident by its ID.",
  {
    incident_id: z.string(),
  },
  async ({ incident_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/incidents/${incident_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "update-incident",
  "Update specific fields of an incident.",
  {
    incident_id: z.string(),
    updates: z.record(z.unknown()).describe("Partial incident object with fields to update."),
    wait_for_commit: z.boolean().optional(),
  },
  async ({ incident_id, updates, wait_for_commit }) => {
    try {
      const data = await apiRequest(
        "PATCH",
        `/aiops/api/v2/incidents/${incident_id}`,
        updates,
        { wait_for_commit }
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-incident-timeline",
  "Get all timeline entries for an incident.",
  {
    incident_id: z.string(),
  },
  async ({ incident_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/incidents/${incident_id}/timeline-entries`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "add-incident-comment",
  "Add a comment to an incident timeline.",
  {
    incident_id: z.string(),
    text: z.string().describe("Comment text."),
  },
  async ({ incident_id, text }) => {
    try {
      const data = await apiRequest(
        "POST",
        `/aiops/api/v2/incidents/${incident_id}/timeline-entries`,
        { type: "comment", comment: text }
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// ===========================================================================
// POLICIES
// ===========================================================================

server.tool(
  "get-policies",
  "List all policies. Supports name search, state filtering, and pagination. Defaults to 20 results per page to keep responses manageable — increase paginationResponseSize if you need more.",
  {
    policyName: z.string().optional().describe("Prefix search on policy name."),
    state: z.enum(["enabled", "disabled", "draft", "archived"]).optional().describe("Filter by lifecycle state."),
    paginationFrom: z.number().optional().describe("Pagination offset (default 0)."),
    paginationResponseSize: z.number().optional().describe("Page size (default 20, max 1000)."),
  },
  async ({ policyName, state, paginationFrom, paginationResponseSize }) => {
    try {
      // The policies filter uses bracket-notation query params: filter[key]=value
      // These are built into the path directly since apiRequest uses flat key=value serialisation.
      const params = new URLSearchParams();
      if (policyName) params.append("filter[policyName]", policyName);
      params.append("filter[paginationFrom]", String(paginationFrom ?? 0));
      params.append("filter[paginationResponseSize]", String(paginationResponseSize ?? 20));
      if (state) params.append("state", state);
      const path = `/aiops/api/v2/configuration/policies?${params.toString()}`;
      const data = await apiRequest("GET", path);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-policy",
  "Retrieve a single policy by ID.",
  {
    policy_id: z.string(),
  },
  async ({ policy_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/policies/${policy_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "create-policy",
  "Create a new policy.",
  {
    policy: z.record(z.unknown()).describe("Policy object."),
  },
  async ({ policy }) => {
    try {
      const data = await apiRequest("POST", "/aiops/api/v2/configuration/policies", policy);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "create-policies-bulk",
  "Create multiple policies in a single request.",
  {
    policies: z.array(z.record(z.unknown())).describe("Array of policy objects."),
  },
  async ({ policies }) => {
    try {
      const data = await apiRequest(
        "POST",
        "/aiops/api/v2/configuration/policies/ids",
        policies
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "update-policy",
  "Partially update a policy by ID (PATCH). Supported fields: policyname (string), policystate (string, e.g. 'enabled' or 'disabled'), commenttext (string).",
  {
    policy_id: z.string(),
    updates: z.record(z.unknown()).describe("Fields to update. Supported keys: policyname, policystate, commenttext."),
  },
  async ({ policy_id, updates }) => {
    try {
      const data = await apiRequest(
        "PATCH",
        `/aiops/api/v2/configuration/policies/${policy_id}`,
        undefined,
        updates as Record<string, string | boolean | undefined>
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "replace-policy",
  "Replace an entire policy by ID (PUT).",
  {
    policy_id: z.string(),
    policy: z.record(z.unknown()).describe("Full policy object."),
  },
  async ({ policy_id, policy }) => {
    try {
      const data = await apiRequest(
        "PUT",
        `/aiops/api/v2/configuration/policies/${policy_id}`,
        policy
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "delete-policy",
  "Delete a policy by ID.",
  {
    policy_id: z.string(),
  },
  async ({ policy_id }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        `/aiops/api/v2/configuration/policies/${policy_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-policy-execution-status",
  "Retrieve execution status for a policy.",
  {
    policy_id: z.string(),
  },
  async ({ policy_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/policies/${policy_id}/status`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-policy-timeline",
  "Retrieve timeline entries for a policy.",
  {
    policy_id: z.string(),
  },
  async ({ policy_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/policies/${policy_id}/timeline-entries`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// ===========================================================================
// RUNBOOKS
// ===========================================================================

server.tool(
  "get-runbooks",
  "List all runbooks.",
  {},
  async () => {
    try {
      const data = await apiRequest("GET", "/aiops/api/v2/configuration/runbooks");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-runbook",
  "Get a runbook by ID.",
  {
    runbook_id: z.string(),
  },
  async ({ runbook_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/runbooks/${runbook_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "create-runbook",
  "Create a new runbook.",
  {
    runbook: z.record(z.unknown()).describe("Runbook object."),
  },
  async ({ runbook }) => {
    try {
      const data = await apiRequest("POST", "/aiops/api/v2/configuration/runbooks", runbook);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "update-runbook",
  "Update an existing runbook.",
  {
    runbook_id: z.string(),
    updates: z.record(z.unknown()),
  },
  async ({ runbook_id, updates }) => {
    try {
      const data = await apiRequest(
        "PATCH",
        `/aiops/api/v2/configuration/runbooks/${runbook_id}`,
        updates
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "delete-runbook",
  "Delete a runbook.",
  {
    runbook_id: z.string(),
  },
  async ({ runbook_id }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        `/aiops/api/v2/configuration/runbooks/${runbook_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-runbook-versions",
  "Get all versions of a runbook.",
  {
    runbook_id: z.string(),
  },
  async ({ runbook_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/runbooks/${runbook_id}/versions`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-runbook-version",
  "Get a specific version of a runbook.",
  {
    runbook_id: z.string(),
    version: z.string().describe("Version identifier."),
  },
  async ({ runbook_id, version }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/runbooks/${runbook_id}/version/${version}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-runbook-references",
  "Get references for a runbook.",
  {
    runbook_id: z.string(),
  },
  async ({ runbook_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/runbooks/${runbook_id}/references`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-runbook-statistics",
  "Get execution statistics for a runbook.",
  {
    runbook_id: z.string(),
  },
  async ({ runbook_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/runbooks/${runbook_id}/stats`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "execute-runbook",
  "Execute a runbook (fire-and-forget or synchronous).",
  {
    runbook_id: z.string(),
    execution: z
      .record(z.unknown())
      .optional()
      .describe("Execution payload (parameters, context, etc.)."),
  },
  async ({ runbook_id, execution }) => {
    try {
      const data = await apiRequest(
        "POST",
        `/aiops/api/v2/configuration/runbooks/${runbook_id}/run`,
        execution ?? {}
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-runbook-executions",
  "Get all executions for a runbook.",
  {
    runbook_id: z.string(),
  },
  async ({ runbook_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/runbooks/${runbook_id}/executions`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-runbook-execution",
  "Get a specific runbook execution by instance ID.",
  {
    runbook_id: z.string(),
    instance_id: z.string(),
  },
  async ({ runbook_id, instance_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/runbooks/${runbook_id}/executions/${instance_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "update-runbook-execution",
  "Update the status or details of a runbook execution.",
  {
    runbook_id: z.string(),
    instance_id: z.string(),
    updates: z.record(z.unknown()),
  },
  async ({ runbook_id, instance_id, updates }) => {
    try {
      const data = await apiRequest(
        "PATCH",
        `/aiops/api/v2/configuration/runbooks/${runbook_id}/executions/${instance_id}`,
        updates
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "delete-runbook-execution",
  "Delete a runbook execution record.",
  {
    runbook_id: z.string(),
    instance_id: z.string(),
  },
  async ({ runbook_id, instance_id }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        `/aiops/api/v2/configuration/runbooks/${runbook_id}/executions/${instance_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// ===========================================================================
// ALGORITHMS
// ===========================================================================

server.tool(
  "get-algorithms",
  "List all registered algorithms.",
  {},
  async () => {
    try {
      const data = await apiRequest(
        "GET",
        "/aiops/api/v2/configuration/algorithms"
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-algorithm",
  "Get a specific algorithm by name.",
  {
    name: z.string().describe("Algorithm name."),
  },
  async ({ name }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/algorithms/${name}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "register-algorithm",
  "Register a new algorithm with the AI platform.",
  {
    algorithm: z.record(z.unknown()).describe("Algorithm registration payload."),
  },
  async ({ algorithm }) => {
    try {
      const data = await apiRequest(
        "POST",
        "/aiops/api/v2/configuration/algorithms",
        algorithm
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "unregister-algorithm",
  "Unregister an algorithm by name.",
  {
    name: z.string(),
  },
  async ({ name }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        `/aiops/api/v2/configuration/algorithms/${name}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// ===========================================================================
// TRAINING
// ===========================================================================

server.tool(
  "get-training-definitions",
  "List all training definitions.",
  {},
  async () => {
    try {
      const data = await apiRequest(
        "GET",
        "/aiops/api/v2/configuration/training/definitions"
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-training-definition",
  "Get a specific training definition by name.",
  {
    name: z.string(),
  },
  async ({ name }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/training/definitions/${name}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "create-training-definition",
  "Create a new training definition.",
  {
    definition: z.record(z.unknown()),
  },
  async ({ definition }) => {
    try {
      const data = await apiRequest(
        "POST",
        "/aiops/api/v2/configuration/training/definitions",
        definition
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "update-training-definition",
  "Update a training definition.",
  {
    name: z.string(),
    updates: z.record(z.unknown()),
  },
  async ({ name, updates }) => {
    try {
      const data = await apiRequest(
        "PATCH",
        `/aiops/api/v2/configuration/training/definitions/${name}`,
        updates
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "delete-training-definition",
  "Delete a training definition.",
  {
    name: z.string(),
  },
  async ({ name }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        `/aiops/api/v2/configuration/training/definitions/${name}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-training-status",
  "Get the latest training run status.",
  {},
  async () => {
    try {
      const data = await apiRequest(
        "GET",
        "/aiops/api/v2/configuration/training/runs/latest"
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "start-training",
  "Start a training run.",
  {
    payload: z.record(z.unknown()).optional().describe("Training run configuration."),
  },
  async ({ payload }) => {
    try {
      const data = await apiRequest(
        "POST",
        "/aiops/api/v2/configuration/training/runs",
        payload ?? {}
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-precheck-status",
  "Get the latest precheck run status.",
  {},
  async () => {
    try {
      const data = await apiRequest(
        "GET",
        "/aiops/api/v2/configuration/training/prechecks/latest"
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "start-precheck",
  "Start a precheck run.",
  {
    payload: z.record(z.unknown()).optional(),
  },
  async ({ payload }) => {
    try {
      const data = await apiRequest(
        "POST",
        "/aiops/api/v2/configuration/training/prechecks",
        payload ?? {}
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "stop-precheck",
  "Stop the current precheck run.",
  {},
  async () => {
    try {
      const data = await apiRequest(
        "DELETE",
        "/aiops/api/v2/configuration/training/prechecks/latest"
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-trained-model-versions",
  "List all trained model versions.",
  {},
  async () => {
    try {
      const data = await apiRequest(
        "GET",
        "/aiops/api/v2/configuration/training/models"
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-trained-model-version",
  "Get a specific trained model version.",
  {
    version_id: z.string(),
  },
  async ({ version_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/training/models/${version_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "delete-trained-model-version",
  "Delete a trained model version.",
  {
    version_id: z.string(),
  },
  async ({ version_id }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        `/aiops/api/v2/configuration/training/models/${version_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// ===========================================================================
// METERING
// ===========================================================================

server.tool(
  "create-metering-job",
  "Create a new metering job.",
  {
    job: z.record(z.unknown()).describe("Metering job payload."),
  },
  async ({ job }) => {
    try {
      const data = await apiRequest("POST", "/aiops/api/v2/metering/jobs", job);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-metering-job",
  "Get complete information for a metering job.",
  {
    job_id: z.string(),
  },
  async ({ job_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/metering/jobs/${job_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-metering-job-status",
  "Get job status only for a metering job.",
  {
    job_id: z.string(),
  },
  async ({ job_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/metering/jobs/${job_id}/status`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-metering-job-result",
  "Get job result only for a metering job.",
  {
    job_id: z.string(),
  },
  async ({ job_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/metering/jobs/${job_id}/result`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "list-metering-resources",
  "List metering resources with pagination and filtering.",
  {
    filter: z.string().optional(),
    page: z.string().optional(),
    page_size: z.string().optional(),
  },
  async ({ filter, page, page_size }) => {
    try {
      const data = await apiRequest(
        "GET",
        "/aiops/api/v2/metering/resources",
        undefined,
        { filter, page, page_size }
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-metering-aggregate-stats",
  "Get aggregate resource stats for a date range.",
  {
    start_date: z.string().describe("Start date (ISO 8601)."),
    end_date: z.string().describe("End date (ISO 8601)."),
  },
  async ({ start_date, end_date }) => {
    try {
      const data = await apiRequest(
        "GET",
        "/aiops/api/v2/metering/resources/aggregate",
        undefined,
        { start_date, end_date }
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// ===========================================================================
// USER PREFERENCES
// ===========================================================================

server.tool(
  "get-my-preferences",
  "Retrieve the current user's preferences.",
  {},
  async () => {
    try {
      const data = await apiRequest("GET", "/aiops/api/v2/configuration/user-preferences/_self");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "upsert-my-preference",
  "Create or update a preference for the current user.",
  {
    key: z.string().describe("Preference key."),
    value: z.unknown().describe("Preference value."),
  },
  async ({ key, value }) => {
    try {
      const data = await apiRequest(
        "PUT",
        `/aiops/api/v2/configuration/user-preferences/_self/${key}`,
        { value }
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "delete-my-preference",
  "Delete a preference by key for the current user.",
  {
    key: z.string(),
  },
  async ({ key }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        `/aiops/api/v2/configuration/user-preferences/_self/${key}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "admin-get-all-preferences",
  "Admin: retrieve all user preferences.",
  {},
  async () => {
    try {
      const data = await apiRequest("GET", "/aiops/api/v2/configuration/user-preferences");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "admin-get-user-preferences",
  "Admin: retrieve preferences for a specific user.",
  {
    user_id: z.string(),
  },
  async ({ user_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/user-preferences/${user_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "admin-get-user-preference",
  "Admin: retrieve a specific preference by key for a user.",
  {
    user_id: z.string(),
    key: z.string(),
  },
  async ({ user_id, key }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/user-preferences/${user_id}/keys/${key}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "admin-upsert-user-preference",
  "Admin: create or update a preference for a specific user.",
  {
    user_id: z.string(),
    key: z.string(),
    value: z.unknown(),
  },
  async ({ user_id, key, value }) => {
    try {
      const data = await apiRequest(
        "PUT",
        `/aiops/api/v2/configuration/user-preferences/${user_id}/keys/${key}`,
        { value }
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "admin-delete-user-preference",
  "Admin: delete a preference by key for a specific user.",
  {
    user_id: z.string(),
    key: z.string(),
  },
  async ({ user_id, key }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        `/aiops/api/v2/configuration/user-preferences/${user_id}/keys/${key}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "admin-delete-all-user-preferences",
  "Admin: delete all preferences for a specific user.",
  {
    user_id: z.string(),
  },
  async ({ user_id }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        `/aiops/api/v2/configuration/user-preferences/${user_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// ===========================================================================
// TOOLS (Runbook Automation Tools)
// ===========================================================================

server.tool(
  "get-automation-tools",
  "List all runbook automation tools.",
  {},
  async () => {
    try {
      const data = await apiRequest("GET", "/aiops/api/v2/configuration/tools");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-automation-tool",
  "Get a specific runbook automation tool.",
  {
    tool_id: z.string(),
  },
  async ({ tool_id }) => {
    try {
      const data = await apiRequest("GET", `/aiops/api/v2/configuration/tools/${tool_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "create-automation-tool",
  "Create a new runbook automation tool.",
  {
    tool: z.record(z.unknown()),
  },
  async ({ tool }) => {
    try {
      const data = await apiRequest("POST", "/aiops/api/v2/configuration/tools", tool);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "update-automation-tool",
  "Update a runbook automation tool.",
  {
    tool_id: z.string(),
    updates: z.record(z.unknown()),
  },
  async ({ tool_id, updates }) => {
    try {
      const data = await apiRequest(
        "PATCH",
        `/aiops/api/v2/configuration/tools/${tool_id}`,
        updates
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "delete-automation-tool",
  "Delete a runbook automation tool.",
  {
    tool_id: z.string(),
  },
  async ({ tool_id }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        `/aiops/api/v2/configuration/tools/${tool_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// ===========================================================================
// MENUS (UI)
// ===========================================================================

server.tool(
  "get-menus",
  "List all UI menus.",
  {},
  async () => {
    try {
      const data = await apiRequest("GET", "/aiops/api/v2/configuration/menus");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-menu",
  "Get a specific UI menu.",
  {
    menu_id: z.string(),
  },
  async ({ menu_id }) => {
    try {
      const data = await apiRequest("GET", `/aiops/api/v2/configuration/menus/${menu_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "create-menu",
  "Create a new UI menu.",
  {
    menu: z.record(z.unknown()),
  },
  async ({ menu }) => {
    try {
      const data = await apiRequest("POST", "/aiops/api/v2/configuration/menus", menu);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "update-menu",
  "Update a UI menu.",
  {
    menu_id: z.string(),
    updates: z.record(z.unknown()),
  },
  async ({ menu_id, updates }) => {
    try {
      const data = await apiRequest(
        "PATCH",
        `/aiops/api/v2/configuration/menus/${menu_id}`,
        updates
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "delete-menu",
  "Delete a UI menu.",
  {
    menu_id: z.string(),
  },
  async ({ menu_id }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        `/aiops/api/v2/configuration/menus/${menu_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// ===========================================================================
// VIEWS (UI)
// ===========================================================================

server.tool(
  "get-views",
  "List all UI views.",
  {},
  async () => {
    try {
      const data = await apiRequest("GET", "/aiops/api/v2/configuration/views");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-view",
  "Get a specific UI view.",
  {
    view_id: z.string(),
  },
  async ({ view_id }) => {
    try {
      const data = await apiRequest("GET", `/aiops/api/v2/configuration/views/${view_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "create-view",
  "Create a new UI view.",
  {
    view: z.record(z.unknown()),
  },
  async ({ view }) => {
    try {
      const data = await apiRequest("POST", "/aiops/api/v2/configuration/views", view);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "update-view",
  "Update a UI view.",
  {
    view_id: z.string(),
    updates: z.record(z.unknown()),
  },
  async ({ view_id, updates }) => {
    try {
      const data = await apiRequest(
        "PATCH",
        `/aiops/api/v2/configuration/views/${view_id}`,
        updates
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "delete-view",
  "Delete a UI view.",
  {
    view_id: z.string(),
  },
  async ({ view_id }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        `/aiops/api/v2/configuration/views/${view_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "check-view-name-exists",
  "Check whether a view name exists.",
  {
    name: z.string(),
    type: z.string().optional().describe("View type qualifier."),
  },
  async ({ name, type }) => {
    try {
      const path = type
        ? `/aiops/api/v2/configuration/views/type/${encodeURIComponent(type)}/name/${encodeURIComponent(name)}`
        : `/aiops/api/v2/configuration/views/name/${encodeURIComponent(name)}`;
      const data = await apiRequest("GET", path);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// ===========================================================================
// VISUALIZATION FILTERS (UI)
// ===========================================================================

server.tool(
  "get-viz-filters",
  "List all visualization filters.",
  {},
  async () => {
    try {
      const data = await apiRequest("GET", "/aiops/api/v2/configuration/filters");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "get-viz-filter",
  "Get a specific visualization filter.",
  {
    filter_id: z.string(),
  },
  async ({ filter_id }) => {
    try {
      const data = await apiRequest(
        "GET",
        `/aiops/api/v2/configuration/filters/${filter_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "create-viz-filter",
  "Create a new visualization filter.",
  {
    filter: z.record(z.unknown()),
  },
  async ({ filter }) => {
    try {
      const data = await apiRequest(
        "POST",
        "/aiops/api/v2/configuration/filters",
        filter
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "update-viz-filter",
  "Update a visualization filter.",
  {
    filter_id: z.string(),
    updates: z.record(z.unknown()),
  },
  async ({ filter_id, updates }) => {
    try {
      const data = await apiRequest(
        "PATCH",
        `/aiops/api/v2/configuration/filters/${filter_id}`,
        updates
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "delete-viz-filter",
  "Delete a visualization filter.",
  {
    filter_id: z.string(),
  },
  async ({ filter_id }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        `/aiops/api/v2/configuration/filters/${filter_id}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "delete-viz-filters-bulk",
  "Delete multiple visualization filters.",
  {
    filter_ids: z.array(z.string()).describe("Array of filter IDs to delete."),
  },
  async ({ filter_ids }) => {
    try {
      const data = await apiRequest(
        "DELETE",
        "/aiops/api/v2/configuration/filters",
        { ids: filter_ids }
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "check-viz-filter-name-exists",
  "Check whether a visualization filter name exists.",
  {
    name: z.string(),
    type: z.string().optional(),
  },
  async ({ name, type }) => {
    try {
      const path = type
        ? `/aiops/api/v2/configuration/filters/type/${encodeURIComponent(type)}/name/${encodeURIComponent(name)}`
        : `/aiops/api/v2/configuration/filters/name/${encodeURIComponent(name)}`;
      const data = await apiRequest("GET", path);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// ===========================================================================
// TOPOLOGY UI CONFIG
// ===========================================================================

server.tool(
  "backup-topology-ui-config",
  "Backup the topology UI configuration.",
  {},
  async () => {
    try {
      const data = await apiRequest(
        "GET",
        "/aiops/api/v2/topology/ui-configuration/backup"
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

server.tool(
  "restore-topology-ui-config",
  "Restore the topology UI configuration from a backup.",
  {
    config: z.record(z.unknown()).describe("Configuration object from a previous backup."),
  },
  async ({ config }) => {
    try {
      const data = await apiRequest(
        "POST",
        "/aiops/api/v2/topology/ui-configuration/restore",
        config
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  }
);

// ===========================================================================
// Start
// ===========================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("concert-operate MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
