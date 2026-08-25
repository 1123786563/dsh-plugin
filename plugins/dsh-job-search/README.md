# dsh-job-search

English | [中文](README.zh.md)

Tenant-isolated job search for DeepSeek Harness: a candidate profile, job scraping over pluggable portal adapters, fit ranking, application tracking, interview prep, and a session-header pipeline dashboard.

## What it adds

- **Tools** (model-facing): `job_search_setup` → `job_search_scrape` → `job_search_rank` → `job_search_apply` → `job_search_interview_prep` → `job_search_outcome`. Generation tools return an assembled brief (profile + posting + fit + writing guidance); the model in the session writes the actual CV and cover letter from it.
- **Dashboard** (browser): a session-header "求职看板" action over the read-only `/plugins/dsh-job-search/pipeline.json` route — profile line, application funnel, recent jobs and applications. Appears only once the tenant's pipeline carries content.
- **Storage**: a `job_search` storage domain (`profiles` / `jobs` / `applications`) keyed by an opaque `TenantId`; every query filters by tenant, so one tenant's data never reaches another. Requires the profile to provide the storage stack (`dsh-storage` + a backend + `dsh-storage-domain`) — the shipped web profile does.

## Install into a profile

```sh
pnpm dsh plugin --profile web add link:/Users/wuyongjun/trea/dsh-plugin/plugins/dsh-job-search
```

The package declares `dsh.bundle.patch`, so `dsh plugin` appends it to `dsh.profile.bundles` automatically; restart `dsh web` afterwards.

## Configuration (profile `cordis.patch.yml`)

```yaml
- id: job-search
  config:
    defaultTenantId: default
    portals:
      - id: freehire
        label: FreeHire
        searchUrl: 'https://freehire.me/api/jobs?search={query}&location={location}'
        enabled: true
```

`portals` is the JSON-feed adapter list (`{query}` / `{location}` placeholders). Boards needing authorized access (BOSS直聘, 拉勾) are not shipped: implement one `PortalAdapter` per board with the operator's own credentials — the seam in `src/portals.ts` is the whole contract.

## Develop

```sh
pnpm install
pnpm test && pnpm typecheck && pnpm build
```

## Known limitations

- Fit scoring is a keyword-overlap heuristic (`src/tools.ts`); the model refines it in-session.
- No CV/cover-letter PDF compilation (LaTeX/ATS pipeline from the source workflow is not ported).
- The dashboard is pull-only (activation, reconnect, manual refresh).
