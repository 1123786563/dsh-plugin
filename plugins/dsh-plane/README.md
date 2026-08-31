# dsh-plane

[Plane](https://github.com/makeplane/plane) as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin — **with the Plane engine running inside the harness process**, no containers, no Python, no database server: a TypeScript Plane-compatible engine (workspaces, projects, work items, states, labels, cycles, modules, comments) persisting to a JSON store under `$DSH_HOME/plane`, a `/api/v1`-compatible HTTP surface official tooling (plane-sdk, plane-mcp-server, curl) can point at, the agent's `plane_*` tool family, a settings card (Settings → Plugins), a sidebar panel, and a standalone board page at `/plugins/dsh-plane/app`.

This is a clean-room compatible implementation of Plane's public API contract — no Plane source code is vendored or copied (Plane is AGPL-3.0; this plugin stays MIT). When you need the full Plane feature set (pages, views, intake, SSO, live collaboration) flip `backend` to `remote` and point the same tools at Plane Cloud or a self-hosted instance.

## How it fits together

```
plane_* tools ──────┐
board page (ui) ────┼── PlaneV1Router ── PlaneEngine ── store.json ($DSH_HOME/plane)
external SDK/MCP ───┘   (in-process)      (domain ops)    (atomic writes + .bak)
                       ▲
                       └─ /plugins/dsh-plane/api/v1/*  — X-API-Key guarded
                       └─ /plugins/dsh-plane/ui/v1/*   — same-origin, keyless
```

- **Backend `local` (default)**: the engine boots lazily on first use, seeds one `dsh` workspace, one `DSH` project, and Plane's default workflow states (Backlog / Todo / In Progress / Done / Cancelled). Work items get per-project sequence ids (`DSH-1`, `DSH-2`, …); entering a completed state stamps `completed_at`. Every mutation persists through a serial atomic-save chain (tmp + rename, previous file kept as `.bak`, restore-on-corrupt).
- **Backend `remote`**: the exact pre-engine behavior — a REST client over Plane Cloud (`api.plane.so`) or a self-hosted instance, with the once-per-activation `work-items` vs legacy `issues` segment negotiation. Settings-card saves flip the backend live, no restart.

## Tools

| Tool | What it does |
| --- | --- |
| `plane_list_projects` | List workspace projects, one cursor page at a time |
| `plane_create_project` | Create a project (seeds the default states) |
| `plane_update_project` | Partially update a project (name, identifier, description, network) |
| `plane_list_issues` | List a project's work items with pagination and ordering |
| `plane_search_issues` | Search work items by name, description, or identifier (workspace-wide or in one project) |
| `plane_get_issue` | Fetch one work item with full detail |
| `plane_create_issue` | Create a work item (title, description HTML, priority, state, assignees, labels, parent, dates) |
| `plane_update_issue` | Partially update a work item (move states, reprioritize, reassign) |
| `plane_delete_issue` | Delete a work item |
| `plane_list_issue_comments` | List the discussion on one work item |
| `plane_create_issue_comment` | Comment on one work item |
| `plane_list_metadata` | List states, labels, or cycles of one project |
| `plane_request` | Raw `GET/POST/PATCH/DELETE` against any `/api/v1` path (modules, intake, milestones, members, ...) |

List tools return curated projections so a page stays small in the model context; cursor envelopes are normalized to `{ results, totalCount, nextCursor, hasNextPage }`. The local engine emits Plane's real envelope keys (`total_count`, `next_cursor`, `prev_cursor`, `next_page_results`, …) with `value:offset:is_prev` cursors, matching the public API.

## HTTP surfaces (local backend)

| Path | Auth | Serves |
| --- | --- | --- |
| `/plugins/dsh-plane/api/v1/...` | `X-API-Key: <engine key>` | The v1-compatible surface — point plane-sdk, plane-mcp-server, or curl here |
| `/plugins/dsh-plane/ui/v1/...` | same-origin (none) | The same router, for the plugin's own browser half — the key never reaches the page |
| `/plugins/dsh-plane/app` | same-origin (none) | The standalone board page (board/list views, detail drawer, comments) |
| `/plugins/dsh-plane/panel` `/state` | same-origin (none) | Sidebar panel data and connection/engine status |

The engine's key is generated on first boot and shown in the settings card (local backend). The v1 surface covers work items, projects, states, labels, cycles (+ cycle-issues), modules (+ module-issues), members, and `users/me`; both `work-items/` and legacy `issues/` path segments work. Anything else answers 404 with a clear error.

## Settings card (Web UI)

Configuration lives in **Settings → Plugins**, on the `plane` namespace:

- `backend` — `local` (in-process engine) or `remote` (REST client); saves flip live
- local: `dataDir` (store directory, default `$DSH_HOME/plane`; changes apply after restart), plus a live engine status block (project/work-item/comment counts and the engine API key)
- remote: `baseUrl`, `apiKey` (secret role — redacted on read-back, empty draft means "keep unchanged")
- both: `workspaceSlug` (local falls back to the seeded `dsh`), `defaultProjectId`, `perPage`

## Sidebar panel (better-sidebar)

With better-sidebar installed, the Plane tab shows the workspace's projects and the selected project's work items with inline quick-edit (state and priority selects), an inline create box, and a link to the full board page (local backend). Remote mode keeps the read-only list behavior. Data comes from the Host's routes — **the remote API key never reaches the browser**.

## Install into a dsh profile

```sh
pnpm dsh plugin --profile web add link:/path/to/dsh-plane
```

The package declares `dsh.bundle.patch` and `dsh.client` (web); restart `dsh web` after changing the bundle list. Nothing else to deploy — the local backend needs no containers or services.

## Configure

Three layers, later wins: the bundle patch's env defaults (`PLANE_BACKEND`, `PLANE_BASE_URL`, `PLANE_API_KEY`, `PLANE_WORKSPACE_SLUG`, `PLANE_DEFAULT_PROJECT_ID`, `DSH_PLANE_DATA_DIR`) → the profile's `cordis.patch.yml` → the settings document the card writes.

## Development

```sh
pnpm install
pnpm test        # vitest: engine domain, v1 router contract, tools over both backends, routes, card form
pnpm typecheck
pnpm build       # tsc declarations, tsdown host bundle, esbuild client factory + standalone board bundle
```

Layout: `src/engine/` the domain engine (models, JSON store, pagination, serializers, key), `src/api/router.ts` the v1-compatible router (path matching shared by tools, HTTP mounts, and tests), `src/backend.ts` the local/remote backend seam, `src/client.ts` the remote REST client, `src/tools.ts` tool definitions, `src/routes.ts` the webServer mounts, `src/client/` the settings-card half, `src/app/` the standalone board page.

## v1 boundaries (intentionally out)

Pages, views, intake, work-item relations, attachments/webhooks, multi-user assignees (the engine is single-principal — the API key owner), live collaboration, and remote→local data migration. Casdoor-backed identities per assignee are a v2 candidate on the local backend.

## License

MIT
