# concert-operate-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for **IBM Concert Operate** (formerly IBM Cloud Pak for AIOps). Connects any MCP-compatible AI assistant to your Concert Operate instance, exposing the full v2 REST API as callable tools.

## Compatibility

| Package version | Concert Operate version |
|---|---|
| `1.x` | `5.1.x` |

## Prerequisites

- [Node.js](https://nodejs.org) 18 or later
- A running Concert Operate instance (Cloud Pak for AIOps)

## Installation

### Option A — npx (recommended, no install required)

Add the following to your MCP client config (e.g. `mcp.json` for Bob, `.vscode/mcp.json` for GitHub Copilot in VSCode (change "mcpServers" to "servers"), `~/.cursor/mcp.json` for Cursor):

```json
{
  "mcpServers": {
    "concert-operate": {
      "command": "npx",
      "args": ["-y", "concert-operate-mcp"],
      "env": {
        "CONCERT_BASE_URL": "https://your-instance.example.com",
        "CONCERT_CPD_USER": "cpadmin",
        "CONCERT_CPD_PASSWORD": "yourpassword"
      }
    }
  }
}
```

### Option B — global install

```bash
npm install -g concert-operate-mcp
```

Then use `concert-operate-mcp` as the command instead of `npx`:

```json
{
  "mcpServers": {
    "concert-operate": {
      "command": "concert-operate-mcp",
      "args": [],
      "env": {
        "CONCERT_BASE_URL": "https://your-instance.example.com",
        "CONCERT_CPD_USER": "cpadmin",
        "CONCERT_CPD_PASSWORD": "yourpassword"
      }
    }
  }
}
```

### Option C — build from source

```bash
git clone https://github.com/ibm-client-engineering/concert-operate-mcp
cd concert-operate-mcp
npm install
npm run build
```

Then point your MCP client at the absolute path to `build/index.js`.

## Configuration

| Environment variable | Required | Default | Description |
|---|---|---|---|
| `CONCERT_BASE_URL` | ✅ | — | Base URL of your Concert Operate instance, e.g. `https://cpd.example.com` |
| `CONCERT_CPD_USER` | ✅ | — | Cloud Pak for Data username |
| `CONCERT_CPD_PASSWORD` | ✅ | — | Cloud Pak for Data password |
| `CONCERT_TENANT_ID` | ❌ | `cfd95b7e-3bc7-4006-a4a8-a73a79c71255` | Tenant ID. The default is the standard value shipped with every Concert Operate installation. Override only if your instance uses a custom tenant ID. |

### Self-signed certificates

TechZone and many on-premises Concert Operate deployments use self-signed TLS certificates. The server automatically bypasses certificate verification (`rejectUnauthorized: false`), matching the behaviour of `curl -k`. If your instance has a valid trusted certificate this has no effect.

### Token lifecycle

The server authenticates against the CPD platform auth endpoint (`/icp4d-api/v1/authorize`) on first use and caches the token for approximately 11 hours 45 minutes (proactive refresh before the ~12-hour CPD expiry). If a `401` is received mid-session the token is force-refreshed and the request is automatically retried once.

## Available tools

### Events
| Tool | Description |
|---|---|
| `create-event` | Create a new event |

### Alerts
| Tool | Description |
|---|---|
| `create-alert` | Create a new alert |
| `get-alerts` | List alerts, optionally filtered (e.g. `severity = 6 or severity = 5`) |
| `get-alert` | Get a single alert by ID |
| `update-alert` | Update fields on an alert |
| `bulk-update-alerts` | Update all alerts matching a filter |
| `get-alert-timeline` | Get timeline entries for an alert |
| `add-alert-comment` | Add a comment to an alert timeline |
| `get-alert-insights` | Get insights for an alert |
| `create-alert-insight` | Add an insight to an alert |
| `get-alert-insight` | Get a specific insight by ID and type |
| `delete-alert-insight` | Delete a specific insight |

### Incidents
| Tool | Description |
|---|---|
| `get-incidents` | List all incidents |
| `get-incident` | Get a single incident by ID |
| `update-incident` | Update fields on an incident |
| `get-incident-timeline` | Get timeline entries for an incident |
| `add-incident-comment` | Add a comment to an incident timeline |

### Policies
| Tool | Description |
|---|---|
| `get-policies` | List all policies |
| `get-policy` | Get a policy by ID |
| `create-policy` | Create a new policy |
| `create-policies-bulk` | Create multiple policies in one request |
| `update-policy` | Partially update a policy (PATCH) |
| `replace-policy` | Replace a policy entirely (PUT) |
| `delete-policy` | Delete a policy |
| `get-policy-execution-status` | Get execution status for a policy |
| `get-policy-timeline` | Get timeline entries for a policy |

### Runbooks
| Tool | Description |
|---|---|
| `get-runbooks` | List all runbooks |
| `get-runbook` | Get a runbook by ID |
| `create-runbook` | Create a new runbook |
| `update-runbook` | Update a runbook |
| `delete-runbook` | Delete a runbook |
| `get-runbook-versions` | List all versions of a runbook |
| `get-runbook-version` | Get a specific runbook version |
| `get-runbook-references` | Get references for a runbook |
| `get-runbook-statistics` | Get execution statistics for a runbook |
| `execute-runbook` | Execute a runbook |
| `get-runbook-executions` | List all executions for a runbook |
| `get-runbook-execution` | Get a specific execution by instance ID |
| `update-runbook-execution` | Update a runbook execution |
| `delete-runbook-execution` | Delete a runbook execution record |

### Algorithms
| Tool | Description |
|---|---|
| `get-algorithms` | List all registered algorithms |
| `get-algorithm` | Get an algorithm by name |
| `register-algorithm` | Register a new algorithm |
| `unregister-algorithm` | Unregister an algorithm |

### Training
| Tool | Description |
|---|---|
| `get-training-definitions` | List all training definitions |
| `get-training-definition` | Get a training definition by name |
| `create-training-definition` | Create a training definition |
| `update-training-definition` | Update a training definition |
| `delete-training-definition` | Delete a training definition |
| `get-training-status` | Get the latest training run status |
| `start-training` | Start a training run |
| `get-precheck-status` | Get the latest precheck status |
| `start-precheck` | Start a precheck run |
| `stop-precheck` | Stop the current precheck run |
| `get-trained-model-versions` | List all trained model versions |
| `get-trained-model-version` | Get a trained model version |
| `delete-trained-model-version` | Delete a trained model version |

### Metering
| Tool | Description |
|---|---|
| `create-metering-job` | Create a metering job |
| `get-metering-job` | Get a metering job |
| `get-metering-job-status` | Get metering job status |
| `get-metering-job-result` | Get metering job result |
| `list-metering-resources` | List metering resources |
| `get-metering-aggregate-stats` | Get aggregate resource stats for a date range |

### User Preferences
| Tool | Description |
|---|---|
| `get-my-preferences` | Get current user preferences |
| `upsert-my-preference` | Create or update a preference |
| `delete-my-preference` | Delete a preference |
| `admin-get-all-preferences` | (Admin) Get all user preferences |
| `admin-get-user-preferences` | (Admin) Get preferences for a user |
| `admin-get-user-preference` | (Admin) Get a specific preference for a user |
| `admin-upsert-user-preference` | (Admin) Create or update a preference for a user |
| `admin-delete-user-preference` | (Admin) Delete a preference for a user |
| `admin-delete-all-user-preferences` | (Admin) Delete all preferences for a user |

### Automation Tools
| Tool | Description |
|---|---|
| `get-automation-tools` | List all runbook automation tools |
| `get-automation-tool` | Get an automation tool |
| `create-automation-tool` | Create an automation tool |
| `update-automation-tool` | Update an automation tool |
| `delete-automation-tool` | Delete an automation tool |

### UI — Menus, Views, Visualization Filters
| Tool | Description |
|---|---|
| `get-menus` / `get-menu` / `create-menu` / `update-menu` / `delete-menu` | Menu CRUD |
| `get-views` / `get-view` / `create-view` / `update-view` / `delete-view` / `check-view-name-exists` | View CRUD |
| `get-viz-filters` / `get-viz-filter` / `create-viz-filter` / `update-viz-filter` / `delete-viz-filter` / `delete-viz-filters-bulk` / `check-viz-filter-name-exists` | Visualization filter CRUD |

### Topology UI Configuration
| Tool | Description |
|---|---|
| `backup-topology-ui-config` | Backup topology UI configuration |
| `restore-topology-ui-config` | Restore topology UI configuration |

## Development

```powershell
git clone https://github.com/ibm-client-engineering/concert-operate-mcp
cd concert-operate-mcp
npm install
npm run build        # compiles src/index.ts → build/index.js
npm run dev          # watch mode
```

To test locally with the MCP Inspector:

```powershell
$env:CONCERT_BASE_URL="https://your-instance.example.com"
$env:CONCERT_CPD_USER="cpadmin"
$env:CONCERT_CPD_PASSWORD="yourpassword"
npx @modelcontextprotocol/inspector node build/index.js
```
## Releasing a new version

1. Make and test your changes
2. Run `npm run build` to confirm it compiles cleanly
3. Bump the version and create the git tag:

    ```powershell
    npm version patch   # bug fix:        1.0.0 → 1.0.1
    npm version minor   # new endpoints:  1.0.0 → 1.1.0
    npm version major   # breaking change (new Concert major): 1.0.0 → 2.0.0
    ```
4. Push the commit and tag:

    ```powershell
    git push --follow-tags
    ```

The GitHub Actions workflow triggers automatically on the tag push, builds the package, and publishes it to npm. No manual npm publish needed.

### Version compatibility
| npm package major | Concert Operate version |
|---|---|
| 1.x | 5.1.x |

When a new major Concert Operate version introduces breaking API changes, bump the npm major version and update this table.

## Contributing

Issues and pull requests welcome. When adding tools for a new API version, please update the compatibility table above.

## License

MIT
