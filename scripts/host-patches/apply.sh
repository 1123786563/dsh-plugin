#!/usr/bin/env bash
# Apply the deepseek-harness dsh-request-guard host patch to a target checkout.
#
# The patch file sits next to this script. Baseline/tip metadata lives in
# scripts/host-patches/README.md (kept out of the patch so `git apply` can
# consume it directly). See ADR-0004 in plugins/dsh-casdoor-auth/docs/adr/.
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PATCH_FILE="${SCRIPT_DIR}/deepseek-harness.dsh-request-guard.patch"
readonly BASELINE_COMMIT="cd5ef8148158c3a752a658978873241fdf8e2bbc"
readonly BRANCH_TIP_COMMIT="d56a51edb79c7cd55ae6bc6183662c7a37030a32"

usage() {
  cat <<EOF
Usage: apply.sh --repo <path> [--check]

Apply the dsh-request-guard host patch to a deepseek-harness checkout.

Options:
  --repo <path>  Target git repository (default: \$DSH_HOST_REPO).
  --check        Dry-run: probe and validate only; never modify the worktree.
  --help         Show this help.

Exit codes:
  0  patch applied, or already applied (idempotent skip)
  1  patch does not apply (baseline mismatch / conflict)
  2  usage error
EOF
}

die_usage() {
  echo "error: $1" >&2
  usage >&2
  exit 2
}

REPO="${DSH_HOST_REPO:-}"
CHECK_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || die_usage "--repo requires a <path> argument"
      REPO="$2"
      shift 2
      ;;
    --check)
      CHECK_ONLY=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      die_usage "unknown argument: $1"
      ;;
  esac
done

[[ -n "$REPO" ]] || die_usage "no target repo: pass --repo <path> or set DSH_HOST_REPO"
[[ -f "$PATCH_FILE" ]] || { echo "error: patch file not found: $PATCH_FILE" >&2; exit 2; }

if ! git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: $REPO is not a git work tree" >&2
  exit 2
fi

# Number of files the patch touches, counted from its "diff --git" headers.
# A zero-match grep exits 1 and would kill the script silently under set -e,
# so tolerate it here and diagnose explicitly.
FILE_COUNT="$(grep -c '^diff --git ' "$PATCH_FILE" || true)"
if [[ "$FILE_COUNT" -eq 0 ]]; then
  echo "error: $(basename "$PATCH_FILE") has no 'diff --git' headers — corrupt or wrong patch file" >&2
  exit 1
fi

# Idempotent probe: the patch reverse-applies iff its changes are present.
if git -C "$REPO" apply --check --reverse "$PATCH_FILE" 2>/dev/null; then
  echo "already applied, skipping: $(basename "$PATCH_FILE") on $REPO ($FILE_COUNT files, tip $BRANCH_TIP_COMMIT)"
  exit 0
fi

# Forward dry-run against the current worktree.
if ! probe_err="$(git -C "$REPO" apply --check "$PATCH_FILE" 2>&1)"; then
  echo "error: $(basename "$PATCH_FILE") does not apply cleanly to $REPO" >&2
  echo "hint: baseline is $BASELINE_COMMIT — rebase the target onto that upstream (or resolve conflicts); if part of the patch is already applied, roll those files back first (see 回退 in scripts/host-patches/README.md)" >&2
  echo "$probe_err" >&2
  exit 1
fi

if [[ "$CHECK_ONLY" == true ]]; then
  echo "check ok: $(basename "$PATCH_FILE") would apply cleanly to $REPO ($FILE_COUNT files, baseline $BASELINE_COMMIT)"
  exit 0
fi

git -C "$REPO" apply "$PATCH_FILE"

# Post-apply confirmation: the patch must now reverse-apply.
if ! git -C "$REPO" apply --check --reverse "$PATCH_FILE" 2>/dev/null; then
  echo "error: applied but reverse-probe failed for $(basename "$PATCH_FILE") on $REPO — inspect the worktree" >&2
  exit 1
fi

echo "applied: $(basename "$PATCH_FILE") to $REPO ($FILE_COUNT files, baseline $BASELINE_COMMIT)"
echo "changes are uncommitted in the working tree — review, then commit in the host repo (see scripts/host-patches/README.md)"
