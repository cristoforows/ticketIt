# Issue tracker: GitHub

Issues and PRDs live in `cristoforows/ticketIt`.
Use the `gh` CLI for issue operations.

## Repository and account

- Always pass `--repo cristoforows/ticketIt` explicitly.
- Use the isolated local CLI profile for every `gh` invocation:
  `GH_CONFIG_DIR="$HOME/.config/gh-cristoforows" gh ...`.
  The default profile may select `wesleySusanto`; do not switch that shared
  profile to perform this project's operations.
- Git uses SSH. The standard SSH remote is
  `git@github.com:cristoforows/ticketIt.git`.
- Git SSH authentication and `gh` API authentication are separate.
  Git's `user.name` is commit metadata, not proof of authentication.
- Before GitHub writes, run
  `GH_CONFIG_DIR="$HOME/.config/gh-cristoforows" gh api user --jq .login`.
  The result must be `cristoforows`.
- If another account is returned, stop and ask the user to select
  or authenticate `cristoforows`. Never write as `wesleySusanto`.
- If the repository is unavailable, ask the user to resolve access
  or approve repository creation.
- Environment tokens such as `GH_TOKEN` or `GITHUB_TOKEN` may override stored
  authentication. The identity check remains required; never print token values.

This profile is for development-agent access to the repository. It is separate
from ticketIt's runtime GitHub OAuth sign-in and Michelin's local PAT connection.

## Conventions

- Create:
  `GH_CONFIG_DIR="$HOME/.config/gh-cristoforows" gh issue create --repo cristoforows/ticketIt --title "..." --body "..."`
  For multiline bodies, use `--body-file <path>`.
- Read, including labels and comments:
  `GH_CONFIG_DIR="$HOME/.config/gh-cristoforows" gh issue view <number> --repo cristoforows/ticketIt --json number,title,body,labels,comments`
- List:
  `GH_CONFIG_DIR="$HOME/.config/gh-cristoforows" gh issue list --repo cristoforows/ticketIt --state open --json number,title,body,labels`
  Add appropriate label and state filters.
- Comment:
  `GH_CONFIG_DIR="$HOME/.config/gh-cristoforows" gh issue comment <number> --repo cristoforows/ticketIt --body "..."`
- Apply or remove labels:
  `GH_CONFIG_DIR="$HOME/.config/gh-cristoforows" gh issue edit <number> --repo cristoforows/ticketIt --add-label "..."`
  or use `--remove-label "..."`.
- Close:
  `GH_CONFIG_DIR="$HOME/.config/gh-cristoforows" gh issue close <number> --repo cristoforows/ticketIt --comment "..."`

## Skill terminology

“Publish to the issue tracker” means create a GitHub issue.

“Fetch the relevant ticket” means read the GitHub issue,
including its labels and comments.
