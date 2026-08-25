# dsh-plane

[Plane](https://github.com/makeplane/plane) as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin: the agent gets a `plane_*` tool family over the Plane REST API — projects, work items (issues), comments, cycles, states, labels — plus a raw-request escape hatch that reaches every other endpoint. The Web UI gains a **settings card** (Settings → Plugins) and a **Plane sidebar panel** (requires better-sidebar).

Works with Plane Cloud (`api.plane.so`) and self-hosted instances. The client probes `work-items` vs the legacy `issues` resource segment once per activation, so current and older community editions both work.

## Tools

| Tool | What it does |
| --- | --- |
| `plane_list_projects` | List workspace projects, one cursor page at a time |
| `plane_list_issues` | List a project's work items with pagination and ordering |
| `plane_search_issues` | Search work items by name, description, or identifier (workspace-wide or in one project) |
| `plane_get_issue` | Fetch one work item with full detail |
| `plane_create_issue` | Create a work item (title, description HTML, priority, state, assignees, labels, parent, dates) |
| `plane_update_issue` | Partially update a work item (move states, reprioritize, reassign) |
| `plane_delete_issue` | Delete a work item |
| `plane_list_issue_comments` | List the discussion on one work item |
| `plane_create_issue_comment` | Comment on one work item |
| `plane_list_metadata` | List states, labels, or cycles of one project |
| `plane_request` | Raw `GET/POST/PATCH/DELETE` against any `/api/v1` path (modules, intake, milestones, members, teamspaces, ...) |

List tools return curated projections (ids, names, states, assignees, labels, dates) so a page stays small in the model context; detail tools return the full decoded row. Cursor envelopes are normalized to `{ results, totalCount, nextCursor, hasNextPage }`.

## Settings card (Web UI)

The plugin registers the `plane` settings namespace on the Host and one card for it in the browser's official plugin-configuration tab, so configuration lives in **Settings → Plugins**:

- `baseUrl` — Plane Cloud or your instance origin
- `apiKey` — personal access token; stored as a secret (role `secret`: redacted on read-back, an empty draft means "keep unchanged")
- `workspaceSlug` — default workspace for calls that omit it
- `defaultProjectId` — optional default project
- `perPage` — list page size, 1-100

Saves go through the durable, revision-fenced settings document; committed changes **reconfigure the tools live — no restart**. The composition entry (`cordis.patch.yml`) stays the fallback layer when no settings service is mounted.

## Sidebar panel (better-sidebar)

When better-sidebar is installed, a Plane tab joins the sidebar: a project picker over the configured workspace, the selected project's work items (state / priority / assignees), pagination via "load more", and a 30 s auto-refresh. Data comes from the Host's read-only `/plugins/dsh-plane/panel` route — **the API key never reaches the browser**. Without a key or workspace the panel shows setup banners instead.

## Install into a dsh profile

```sh
pnpm dsh plugin --profile web add link:/path/to/dsh-plane
```

The package declares `dsh.bundle.patch` and `dsh.client` (web), so `dsh plugin` appends `dsh-plane` to `dsh.profile.bundles` automatically and the Web UI serves the browser half under `/plugins` — no rebuild of the web application. From a published package:

```sh
pnpm dsh plugin --profile web add dsh-plane            # npm registry
pnpm dsh plugin --profile web add github:you/dsh-plane # github spec
```

Restart `dsh web` (or the headless run) after changing the bundle list; the tree composes at boot.

## Configure

Three layers, later wins: the bundle patch's env defaults → the profile's `cordis.patch.yml` (`~/.dsh/profiles/<name>/cordis.patch.yml`) → the settings document the card writes.

```yaml
# profile cordis.patch.yml
- id: plane
  config:
    baseUrl: https://plane.example.com   # default https://api.plane.so (Plane Cloud)
    apiKey: plane_api_xxx                # X-API-Key; Profile Settings > Personal Access Tokens
    workspaceSlug: my-team               # default workspace for calls that omit it
    defaultProjectId: ''                 # optional default project
    perPage: 50                          # list page size, max 100
```

`!!js process.env.PLANE_API_KEY` style values work when the dsh process sees the variable. An empty `apiKey` keeps everything registered; calls then fail with setup instructions instead of failing the boot tree. Prefer the settings card — it is live without a restart.

### Choosing values

- `baseUrl`: `https://api.plane.so` on Plane Cloud; your instance origin when self-hosted (a trailing `/api/v1` is tolerated).
- `workspaceSlug`: the URL segment after the host, e.g. `my-team` in `https://app.plane.so/my-team/projects/`.
- `apiKey`: create in Plane under Profile Settings, Personal Access Tokens. The key acts as its owner; comments and created items carry that identity.

## Development

```sh
pnpm install
pnpm test        # vitest, fetch stubbed (client, tools, card form, panel routes)
pnpm typecheck
pnpm build       # tsc declarations to lib/types, tsdown host bundle, esbuild client factory to lib/client.js
```

Layout: `src/client.ts` REST client (auth, errors, item-segment negotiation, pagination, live-config accessor), `src/view.ts` context-frugal projections, `src/tools.ts` tool definitions, `src/routes.ts` read-only panel/state routes, `src/config.ts` schemastery config (apiKey is `role('secret')`), `src/index.ts` host entry (tools + settings namespace + routes), `src/client/*` browser half (card form, settings card, panel, locales).

The browser artifact is the client module system's lazy-CJS factory form: one classic script that only registers `window.__ModuleLoader__.load({ id, factory })`, React external, services through cordis injection (`scripts/build-client.mjs`).

## Notes

- Scopes: personal access tokens carry the owner's permissions; there is no per-tool scope narrowing in this plugin yet.
- Rate limits surface as `Plane API 429` errors with the response excerpt; retry after a pause.
- `plane_request` rejects absolute URLs and `..` traversal; every path is rooted at `/api/v1`.

## License

MIT
