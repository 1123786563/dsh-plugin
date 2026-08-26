# Issue tracker: GitHub

Issues and specs for this repo live as GitHub Issues in `1123786563/dsh-plugin`. Use the `gh` CLI for issue operations.

## Conventions

- Create: `gh issue create --title "..." --body "..."`.
- Read: `gh issue view <number> --comments`, including labels when triaging.
- List: `gh issue list --state open` with label/state filters as needed.
- Comment: `gh issue comment <number> --body "..."`.
- Apply or remove labels with `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close only after the issue's acceptance evidence is recorded: `gh issue close <number> --comment "..."`.

Pull requests are not a triage request surface for this repository. GitHub native issue dependencies are the canonical representation for blocking relationships; use the blocker's numeric database id, not its issue number or node id.

When a skill says “publish to the issue tracker”, create a GitHub Issue. When it says “fetch the relevant ticket”, run `gh issue view <number> --comments`.
