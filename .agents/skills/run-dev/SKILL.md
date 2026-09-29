---
name: run-dev
description: Run ticketIt locally (Galley + Swiftlet dev server + substitute GitHub sign-in) against ticketit_dev, for manual testing of the current checkout. Use when asked to run, start, launch, or stop the app locally.
---

# Run ticketIt locally

Start from the repo root:

```sh
.agents/skills/run-dev/up.sh
```

It stops any previous run, migrates `ticketit_dev`, builds Galley and
`cmd/githubfake`, runs `npm ci` in `apps/swiftlet` when the lockfile
changed, starts all three processes, and signs in once with curl as a
smoke test. It exits non-zero and names the log to read on any failure.

| Process | Address |
|---|---|
| Swiftlet (Vite dev server, HMR) | http://localhost:5173 |
| Galley | http://localhost:8080 |
| githubfake | OS-assigned port, printed on start |

Stop with `.agents/skills/run-dev/down.sh`.

## Rules

- Runs whatever is checked out. To test latest `main`, `git fetch` and
  confirm `main` matches `origin/main` first; report the commit `up.sh`
  prints.
- Sign-in goes through `githubfake`; the Owner is
  `ticketit-test-owner`. Never configure a real GitHub OAuth app
  (`AGENTS.md`, "Paid resources").
- Data persists in `ticketit_dev`. Set `TICKETIT_DEV_DATABASE_URL` to use
  another database. Never point it at `ticketit_test`, `ticketit_e2e*`
  or `ticketit_m1_native`.
- If port 8080 or 5173 is taken, `up.sh` prints the owning process and
  exits; ask the user before killing anything it did not start.
- Logs and PIDs live in `${TMPDIR}/ticketit-dev` (override with
  `TICKETIT_DEV_STATE_DIR`).
- After `up.sh` succeeds, drive the change being tested in a browser
  (claude-in-chrome) before calling it verified; the curl sign-in only
  proves the stack is wired.
