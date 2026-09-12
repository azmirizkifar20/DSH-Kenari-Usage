## Skills Auto-Load

Before implementing any feature, change, extension, or refactoring task, ALWAYS check and load the appropriate skill:
- For feature work (implement, add, create, change, extend, refactor): Load `dsh-kenari-usage-feature-flow` skill first
- The skill defines the required workflow: read docs → trace runtime path → add/update tests when they protect the change → verify → update/create docs

When the user asks for any code change (implement, add, fix, refactor), ALWAYS load `dsh-kenari-usage-feature-flow` before touching code — regardless of task size.

## Documentation Structure

This project uses structured documentation under `docs/`:
- `docs/features/` - Current-state feature documentation
- `docs/steering/` - Technical architecture and stack decisions
- `docs/issue/` - Bug reports and root cause analysis
- `docs/design-system/` - UI conventions and shared components

## Push Workflow

When the user asks to push (e.g. "push", "push commit"), pushing means ship AND reinstall:
1. Commit and push to GitHub as usual.
2. As soon as the push succeeds, re-add the plugin from the just-pushed source so the installed copy matches it: `dsh plugin --profile web add github:azmirizkifar20/DSH-Kenari-Usage` (the `prepare` script rebuilds `dist/` during the add). If the add reports the plugin already exists, run `dsh plugin --profile web remove dsh-kenari-usage` first, then add again.
3. Do NOT restart `dsh web` yourself — end the reply by telling the user the push + re-add is done and the only remaining step is restarting `dsh web` (the client module table is scanned at boot).
