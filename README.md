# E2B sandbox extension for Pi

Run Pi locally while `bash`, `read`, `write`, `edit`, `ls`, `find`, `grep`, and user `!` commands execute in an [E2B](https://docs.e2b.dev/) Linux sandbox. Saved sessions reconnect to their sandbox; forks get an independent copy of its current files and memory.

## Install

Requires Node.js 22+ and Pi. Tested with `@earendil-works/pi-coding-agent` 0.87.1.

```sh
npm install -g @earendil-works/pi-coding-agent
pi install git:github.com/stym06/pi-e2b
export E2B_API_KEY="your-e2b-api-key"
cd /path/to/my-project
pi --e2b
```

The extension clones your local repository's origin and current branch, then creates a dedicated `pi/<session-hash>` branch. Only remote committed contents are cloned; local changes, local-only commits, SSH keys, and host environment variables are not copied. Without an origin, it starts an empty workspace.

## Workspace options

```sh
# Clone a specific repository and branch.
pi --e2b --repo https://github.com/owner/project.git --e2b-branch main

# SSH URLs are converted to HTTPS; no SSH key is needed for public repos.
pi --e2b --repo git@github.com:owner/project.git

# Start empty.
pi --e2b --e2b-no-repo

# Attach to an existing sandbox.
pi --e2b --e2b-sandbox <sandbox-id> --e2b-cwd /home/user/project
```

| Flag | Purpose / default |
| --- | --- |
| `--e2b` | Enable sandbox execution |
| `--repo <url>` / `--e2b-repo <url>` | Repository to clone instead of local origin; accepts HTTPS or SSH |
| `--e2b-branch <name>` | Remote branch; defaults to the detected local branch or remote default |
| `--e2b-no-repo` | Skip repository detection |
| `--e2b-template <name>` | Template name or ID; `E2B_TEMPLATE`, then `base` |
| `--e2b-sandbox <id>` | Attach instead of creating or resuming a session sandbox |
| `--e2b-cwd <path>` | Absolute sandbox path; defaults to `$HOME/workspace` |
| `--e2b-timeout <seconds>` | Idle lifetime; defaults to 900 seconds |
| `--e2b-public` | Allow unauthenticated preview access on new sandboxes |

Export environment variables before starting Pi; `.env` files are not loaded automatically. `E2B_API_KEY` is required. `E2B_TIMEOUT_MS` sets the idle timeout in milliseconds unless overridden by `--e2b-timeout`.

`--repo` uses the remote default branch unless `--e2b-branch` is supplied. Public repositories need no Git credentials. Both `git@github.com:owner/project.git` and `ssh://git@github.com/owner/project.git` are supported. Resuming a session keeps its existing workspace; repository flags apply to new sandboxes.

Templates need `python3`, `bash`, `git`, and `rg`. Setup installs missing `ripgrep` using `apt-get` as root. Creation flags do not change an existing sandbox's settings.

## Private repositories and pushing

Log in on your host once, then start Pi:

```sh
gh auth login --hostname github.com
pi --e2b
# Resume an existing session:
pi --e2b --continue
```

For github.com repositories, the extension automatically retrieves credentials from your local `gh` login for cloning and each push. An exported `E2B_GIT_TOKEN` takes precedence and supports other Git hosts. Repository URLs must use HTTPS without embedded credentials; SSH-style clone origins are converted to HTTPS.

Each session gets a `pi/<session-hash>` branch based on its session ID. Resuming preserves the branch; forks get a new branch from the parent's current state. Older sessions get a branch on their next resume. Empty workspaces get a local Git repository. The remote branch is created on the first push.

Credentials are used for clone/push processes and host-side GitHub API calls; an empty token variable in the sandbox is expected. `/e2b status` shows the credential source without displaying the token. If `gh` is missing or logged out, public cloning still works; log in on the host and retry a push.

Commit changes, then push explicitly:

```text
!git add -A && git commit -m "Describe the change"
/e2b push
```

You can also ask Pi to commit and push; it can use `e2b_git_push`. Pushes send `HEAD` to the current branch on `origin`, never force-push, and use a temporary token helper without storing persistent Git credentials. If needed, configure `user.name` and `user.email` inside the sandbox repository.

Run `/e2b pr` to push committed changes and create a GitHub PR, or `/e2b pr develop --draft` for a draft targeting `develop`. It defaults to the repository's default branch and the latest commit message, returns the PR link, and reuses an existing open PR for the same head/base. It does not commit uncommitted changes. You can also ask Pi to use `e2b_create_pr` with a custom title and description. PR creation supports github.com; fine-grained tokens also need **Pull requests: Read and write** permission.

## Commands and previews

| Command | Behavior |
| --- | --- |
| `/e2b` or `/e2b status` | Show sandbox status and workspace |
| `/e2b pause` | Pause; the next tool call resumes it |
| `/e2b resume` | Reconnect or retry startup |
| `/e2b push` | Push committed changes using host credentials |
| `/e2b pr [base] [--draft]` | Push commits and create or return a GitHub PR |
| `/e2b url 3000` | Show the preview URL for a port |
| `/e2b kill --yes` | Permanently delete the session's sandbox, including an attached one |
| `/e2b new` | Create a replacement after deletion |

For a preview, start a server bound to `0.0.0.0`, then run `/e2b url <port>` or ask Pi to use `preview_url`. Redirect background server output to a sandbox log.

Previews are private by default and require an `e2b-traffic-access-token` header obtained through the E2B SDK. Start with `--e2b-public` for browser access; anyone with the URL can access exposed services. Paused sandboxes cannot serve previews.

## Sessions and isolation

- Saved sessions pause their sandboxes on exit, reload, or session switch and reconnect when resumed. Idle expiration also pauses extension-created sandboxes.
- Forks snapshot the sandbox's current state, including uncommitted changes, rather than historical files at the selected conversation point.
- In-memory sessions (`--no-session`) delete extension-created sandboxes on shutdown. Explicitly attached sandboxes are left running.
- Deleting a Pi session file does not delete its sandbox. Use `/e2b kill --yes` or the E2B dashboard.
- With `--e2b`, connection failures stop tools instead of falling back to local execution. Without it, tools run locally.

Pi, model calls, session logs, local context loading, and other extensions still run on your machine. Avoid extensions that override the same tools or flags.

Bash streams output and defaults to a 120-second timeout; cancellation and timeout terminate the shell process group. For large output, redirect to a sandbox file so Pi can read it later. Pi's local temporary transcripts are not accessible through remote `read`.

## Development

```sh
npm ci
pi -e /path/to/pi-e2b/index.ts --e2b
npm run check       # typecheck, offline tests, and Pi loader smoke test
npm run test:live   # requires E2B_API_KEY; creates and deletes billable sandboxes
npm pack --dry-run
```

Pi loads TypeScript directly; no build step is needed. Use `/reload` or restart Pi after edits. Do not load both the installed extension and a local `-e` copy in the same process.
