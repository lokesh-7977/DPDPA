# Connect an AI assistant (MCP)

The platform runs a read-only [Model Context Protocol](https://modelcontextprotocol.io) server. With it, an AI assistant such as Claude can answer questions about your DPDPA compliance programme: your score and what lowers it, controls and evidence, the evidence backlog, the risk register, and your approved policies.

It cannot change anything, and it does not expose Data Principals' personal data as data. Free text your team wrote (evidence titles and descriptions, risk titles, policy text) is returned as written and is sent to your AI provider.

## 1. Create an API key

An org admin creates a key with the `mcp:read` scope. The platform refuses to combine it with any other scope, so the key in your AI client's configuration can never write. Give it an expiry:

```http
POST /orgs/{orgId}/api-keys
Authorization: Bearer <your login token>
Content-Type: application/json

{ "name": "Claude (MCP)", "scopes": ["mcp:read"], "expiresInDays": 90 }
```

The response shows the key (`dpk_…`) once. Store it like a password. Revoke it at any time with `DELETE /orgs/{orgId}/api-keys/{keyId}`.

## 2. Add the server to your assistant

- **Endpoint:** `https://<your API host>/mcp`
- **Transport:** Streamable HTTP
- **Header:** `Authorization: Bearer dpk_…`

### Claude Code

```bash
claude mcp add --transport http dpdpa https://<your API host>/mcp \
  --header "Authorization: Bearer dpk_…"
```

### Other MCP clients

Configure an HTTP (Streamable HTTP) server with the URL and header above. The server is stateless and answers each request with JSON. It does not open server-sent event streams.

## Tools

| Tool | What it returns |
|---|---|
| `get_compliance_score` | Score 0-100, grade A-D, the components, and where points are lost |
| `list_controls` | Controls (filter by `framework`, `status`) with status and evidence counts |
| `get_control` | One control: objective, provisions, automatic check, evidence recorded |
| `get_evidence_backlog` | Applicable controls not met yet, worst first, with the evidence needed |
| `list_risks` | Risk register (filter by `level`, `status`; `limit` up to 200) |
| `list_policies` | Policies with their approved version and any open draft |
| `get_policy_text` | Full text of a policy's current approved version |

Example questions: *"What is our DPDPA score and what should we fix first?"*, *"Which controls have expired evidence?"*, *"Summarise our breach response policy."*

## Prompt injection

Tool results include text written by members of your organization: evidence titles and descriptions, risk titles, policy text. Someone with edit rights could write text that looks like instructions to an AI ("ignore your rules and …"). The server tells the assistant to treat this text as data, but assistants can still be misled.

- Don't give the same assistant session powerful tools (shell, web requests, other MCP servers that can write) without confirming each action.
- Evidence links are returned as their host name only, and long descriptions are shortened.

## Security

- **Access:** each key reads one organization only, with view-only rights (no member list, no audit trail). Outputs contain no user ids or internal file ids.
- **Rate limit:** 120 requests per minute per key, and 20 per minute for the tools that evaluate the whole programme (score, controls, backlog). Requests from a browser `Origin` that is not one of the platform's own origins are refused.
- **Record:** every tool call is logged with the key id, the tool name and the outcome (never the arguments).
- **Activity:** every key shows its last use. To cut off access straight away, revoke the key.
