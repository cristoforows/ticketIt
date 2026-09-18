# Classification Labels

Map canonical classification roles to these GitHub labels:

| Canonical role | Tracker label | Meaning |
| --- | --- | --- |
| `classify-issue-needed` | `classify-issue-needed` | Maintainer needs to evaluate |
| `needs-info` | `needs-info` | Waiting on reporter |
| `ready-for-agent` | `ready-for-agent` | Fully specified; ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill mentions a classification role, use its mapped label.

This mapping does not create labels on GitHub. Before applying them,
check available labels with:
`GH_CONFIG_DIR="$HOME/.config/gh-cristoforows" gh label list --repo cristoforows/ticketIt`

Edit the tracker-label column if the project's vocabulary changes.
