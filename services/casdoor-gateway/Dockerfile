# Reproducible image for the casdoor auth gateway.
#
# All dependency resolution goes through pnpm-lock.yaml: `pnpm fetch` fills the
# store from the lockfile, install runs `--offline --frozen-lockfile` against
# that store, and `pnpm deploy --prod` prunes the runtime node_modules from the
# same lockfile. The runtime entry is the tsc output `lib/server.js` (same
# artifact as `pnpm start` and scripts/e2e.mjs), so no devtool ships in the
# image.

FROM node:22-slim AS builder
# pnpm version must stay identical to the root package.json `packageManager`.
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /repo
# Root manifests only before the fetch: the dependency layers below cache
# independently of source edits, and `pnpm fetch` reads only the lockfile, so
# it sits right after the root manifests and its cache key ignores workspace
# manifest churn.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Fill the store from the lockfile (the only network-touching dependency layer).
RUN pnpm fetch
# All workspace package.json files are copied after the fetch and before the
# offline install, so manifest edits re-run only the sub-second offline
# install, never the network fetch. The install still resolves the whole
# workspace, so every manifest is provided rather than relying on pnpm
# tolerating missing importer manifests. Drift: removing a workspace package
# without dropping its COPY line fails loudly at that COPY step (missing
# source); forgetting to add a new package's manifest is silent and harmless
# for the gateway build (only its subtree is installed/built/deployed).
# One COPY per manifest: BuildKit flattens glob-matched files, losing the
# directory structure pnpm needs.
COPY plugins/dsh-casdoor-auth/package.json plugins/dsh-casdoor-auth/
COPY plugins/dsh-higress/package.json plugins/dsh-higress/
COPY plugins/dsh-job-search/package.json plugins/dsh-job-search/
COPY plugins/dsh-multi-tenant/package.json plugins/dsh-multi-tenant/
COPY plugins/dsh-multi-tenant/packages/multi-tenant/package.json plugins/dsh-multi-tenant/packages/multi-tenant/
COPY plugins/dsh-nocobase/package.json plugins/dsh-nocobase/
COPY plugins/dsh-open-design/package.json plugins/dsh-open-design/
COPY plugins/dsh-openmeter/package.json plugins/dsh-openmeter/
COPY plugins/dsh-plane/package.json plugins/dsh-plane/
COPY services/casdoor-gateway/package.json services/casdoor-gateway/
COPY services/nocobase/package.json services/nocobase/
RUN pnpm --filter dsh-casdoor-gateway install --offline --frozen-lockfile
COPY services/casdoor-gateway services/casdoor-gateway
RUN pnpm --filter dsh-casdoor-gateway run build
# pnpm >=10 gates `deploy` on inject-workspace-packages=true. Appending it here
# (image-internal only — the repo workspace file is never modified) changes no
# resolution: the gateway has no workspace dependencies and deploy runs
# --offline against the frozen lockfile's store.
RUN printf '\ninjectWorkspacePackages: true\n' >> pnpm-workspace.yaml \
  && pnpm --filter dsh-casdoor-gateway deploy --prod --offline /deploy

FROM node:22-slim
WORKDIR /app
# Explicit copies; deploy's own file-copying semantics are not relied upon.
COPY --from=builder /deploy/node_modules /app/node_modules
COPY --from=builder /repo/services/casdoor-gateway/lib /app/lib
COPY --from=builder /repo/services/casdoor-gateway/package.json /app/package.json
RUN mkdir /data && chown node:node /app /data
USER node
ENV GATEWAY_DATA_DIR=/data NODE_ENV=production
EXPOSE 3080
ENTRYPOINT ["node", "lib/server.js"]
