# E2B sandbox extension for Pi

Run Pi locally while its coding tools execute in an [E2B](https://docs.e2b.dev/) Linux sandbox. Inspired by the execution model of the [Daytona Pi extension](https://pi.dev/packages/@daytona/pi).

The extension redirects `bash`, `read`, `write`, `edit`, `ls`, `find`, `grep`, and user `!` commands. Saved Pi sessions reconnect to their sandbox; forks snapshot the parent's files and memory into an independent sandbox.

## Install from GitHub

Requires Node.js 22 or newer and Pi. This extension is tested with `@earendil-works/pi-coding-agent` 0.87.1.

```sh
npm install -g @earendil-works/pi-coding-agent
pi install git:github.com/stym06/pi-e2b
export E2B_API_KEY="your-e2b-api-key"
pi --e2b
```

For local development from a checkout:

```sh
cd /path/to/pi-e2b
npm install
pi install .
# Or try it once without installing:
pi -e /path/to/pi-e2b/index.ts --e2b
```

This package is not published to npm. Do not load both the installed package and `-e` copy in the same Pi process. Restart Pi or use `/reload` after editing the source. There is no build step: Pi loads TypeScript directly.

## Start a workspace

```sh
# Clone the origin and current branch of your local Git repository.
cd /path/to/my-project
pi --e2b

# Clone a different repository.
pi --e2b --e2b-repo https://github.com/owner/project.git --e2b-branch main

# Start with an empty workspace.
pi --e2b --e2b-no-repo

# Attach to an existing sandbox. The directory must be an absolute Linux path.
pi --e2b --e2b-sandbox <sandbox-id> --e2b-cwd /home/user/project

# Allow browser-accessible previews for a newly created sandbox.
pi --e2b --e2b-public
```

Cloning uses the remote repository's committed contents. Local files, uncommitted changes, local-only commits, SSH keys, and host environment variables are not copied. A local branch must already exist on the remote to clone it. Without a detected origin, the extension creates an empty workspace. SSH-style origins such as `git@github.com:owner/project.git` are converted to HTTPS. Other repository URLs must use HTTPS and must not embed credentials.

For private repositories and explicit pushes, export `E2B_GIT_TOKEN` before starting Pi. For GitHub, use a personal access token with access to this repository and **Contents: Read and write** permission. The token is passed to clone and push processes through a temporary askpass helper; it is not written into Git configuration, URLs, files, or Pi's sandbox session record. The extension does not automatically commit, push, create GitHub branches, or open pull requests. The token is not installed as a persistent Git credential.

After Pi changes files, commit them, then push explicitly:

```text
!git switch -c pi/my-change
!git add -A && git commit -m "Describe the change"
/e2b push
```

You can instead ask Pi: **“Commit the changes on a new branch and push them.”** Pi can call the `e2b_git_push` tool after committing. The tool is intended only for an explicit push request. Both routes use the same temporary token handling.

`/e2b push` pushes `HEAD` to the remote branch with the same name as the current branch. It never force-pushes or commits for you. The sandbox's `origin` must use HTTPS for token authentication. If `git commit` asks for an identity, set one in the sandbox repo with `!git config user.name "Your Name"` and `!git config user.email "you@example.com"`. Restart Pi after exporting or changing `E2B_GIT_TOKEN`; exporting it in a separate terminal does not change a running Pi process. You can avoid pasting a token into shell history with `read -s E2B_GIT_TOKEN; export E2B_GIT_TOKEN` (in zsh, press Return after pasting the token).

The default template is `base`. Templates need `python3`, `bash`, and `git`. If `rg` is missing, setup installs `ripgrep` using `apt-get` as root. For templates without apt/root access, preinstall all four tools. Setup failures clean up newly created sandboxes. Attached sandboxes are never deleted by setup failure.

## Flags and environment

| Flag | Purpose | Default |
| --- | --- | --- |
| `--e2b` | Enable remote execution | Off |
| `--e2b-repo <url>` | Repository to clone | Local Git origin |
| `--e2b-branch <name>` | Remote branch to clone | Local branch when auto-detected; otherwise remote default |
| `--e2b-no-repo` | Skip local repository detection | Off |
| `--e2b-template <name>` | Template name or ID | `E2B_TEMPLATE`, then `base` |
| `--e2b-sandbox <id>` | Attach to an existing sandbox | Create or resume a session sandbox |
| `--e2b-cwd <path>` | Sandbox working directory | Sandbox `$HOME/workspace` |
| `--e2b-timeout <seconds>` | Idle lifetime extended before tool calls | 900 seconds |
| `--e2b-public` | Allow unauthenticated traffic to preview URLs | Off |

`E2B_API_KEY` is required. `E2B_TIMEOUT_MS` sets the idle timeout in **milliseconds**, unless `--e2b-timeout` is supplied. `E2B_GIT_TOKEN` is optional and used for cloning private repositories and explicit pushes. Export these variables in your shell; the extension does not load `.env` files automatically.

Creation flags apply when creating a sandbox. Resuming a session preserves its sandbox ID, working directory, and ownership. Attaching to an existing sandbox preserves its network/lifecycle settings. E2B account runtime limits still apply: configure the timeout within your account's limits.

## Commands

| Command | Behavior |
| --- | --- |
| `/e2b` or `/e2b status` | Show sandbox ID, state, workspace, and exit behavior |
| `/e2b pause` | Pause; the next tool call resumes it |
| `/e2b resume` | Reconnect or retry startup after a failure |
| `/e2b push` | Push commits on the current branch to `origin` using `E2B_GIT_TOKEN` |
| `/e2b url 3000` | Show the preview URL for a port |
| `/e2b kill --yes` | Permanently delete the session's sandbox, including an explicitly attached one |
| `/e2b new` | Create a replacement after deletion, using the current creation flags |

The agent can also call `preview_url` with a port. For example, start a server inside the sandbox with:

```sh
nohup python3 -m http.server 3000 --bind 0.0.0.0 > /tmp/server.log 2>&1 < /dev/null &
```

Then use `/e2b url 3000`. Previews are private by default and require the `e2b-traffic-access-token` header. Retrieve that token through the E2B SDK if needed; the extension does not put it into agent messages. Use `--e2b-public` when creating a sandbox for a directly browser-accessible URL. This makes its exposed services accessible to anyone who knows their URLs. A paused sandbox's services are unavailable until it resumes.

## Persistence and isolation

- Saved sessions pause on exit, reload, or session switch. Their sandbox ID is stored in a custom Pi session entry, so resuming reconnects to the same files. Idle expiration also pauses extension-created sandboxes.
- Forking a Pi session creates an E2B fork with independent filesystem state, including uncommitted changes. It snapshots the sandbox's **current** state; it cannot reconstruct historical files from the conversation point you select.
- In-memory sessions (`--no-session`) delete extension-created sandboxes on shutdown and use kill-on-timeout as a fallback.
- Explicitly attached sandboxes are left running on shutdown. `/e2b pause` and `/e2b kill --yes` remain explicit controls for them.
- Deleting a Pi session file does **not** delete its E2B sandbox. Use `/e2b kill --yes` before deleting the session, or delete the sandbox in E2B's dashboard. The extension does not sweep other sessions' sandboxes.
- If `--e2b` is enabled and startup/reconnection fails, tools fail closed. They never fall back to local execution. The extension does not silently replace an unavailable sandbox or retry commands that might already have executed.
- An externally deleted sandbox can be cleared from a session with `/e2b kill --yes`, then replaced with `/e2b new`.
- Without `--e2b`, the ordinary tools and user shell retain local behavior.

The isolation boundary covers the listed built-in tools. Pi itself, model calls, session logs, local context loading, and other installed extensions still run on your machine. Review custom tools separately. Loading this extension alongside another extension that overrides the same tools or flags is unsupported.

## Tool behavior

File reading, exact-match edits, and directory listing reuse Pi's native tool implementations with E2B file operations, preserving rendering and edit validation. `~` resolves to the sandbox home. `find` and `grep` run ripgrep inside E2B and respect `.gitignore`, include hidden files, and exclude `.git`. Search output is capped at 50 KB; `grep.limit` caps output lines including context, and `find.limit` caps paths. Narrow the search to inspect additional results. `find` lists matching files, not directories.

Bash streams combined stdout/stderr and defaults to a 120-second timeout. The tool's `timeout` parameter is in **seconds**. The sandbox lease is extended for longer commands. Cancellation and timeout terminate the shell process group. Background jobs do not hold the foreground tool open; redirect their output to a named sandbox log, as in the preview example. Transport failures can prevent cancellation from reaching the sandbox; the command's own timeout and sandbox lifetime remain bounded.

Pi's standard output truncation may save a full bash transcript to a **local Pi temporary file**. That path is for the user on the host; remote `read` cannot read it. Redirect large output to a sandbox file when the agent needs to inspect it later, for example `npm test > /tmp/tests.log 2>&1`, then use `read` with offsets.

## Development and validation

```sh
npm ci
npm run check       # typecheck + offline tests + real Pi loader smoke test
npm run test:live   # requires E2B_API_KEY; creates billable sandboxes and deletes them
npm pack --dry-run  # inspect the installable package contents
```

Offline tests exercise the actual Python command/search scripts and a real local Git push, with a local process transport and mock E2B lifecycle APIs. They cover streaming, nonzero exits, cancellation, timeout cleanup, background jobs, repository/path validation, remote editing, search limits/errors, fork isolation, reconnection, cleanup, and fail-closed behavior. The loader smoke test uses Pi's real TypeScript extension loader. The live test covers the real E2B file/command APIs, pause/resume, and forks; it does not need a model API key.

Source layout: `index.ts` registers configuration and lifecycle hooks; `src/session.ts` manages sandboxes; `src/tools.ts` routes tools; `src/ops.ts` implements file operations; `src/commands.ts` and `src/runner.py` run cancellable commands; `src/search.ts` and `src/search.py` implement bounded remote search.

API references: [E2B lifecycle](https://docs.e2b.dev/sandbox), [persistence](https://docs.e2b.dev/sandbox/persistence), [forking](https://docs.e2b.dev/sandbox/fork), [commands](https://docs.e2b.dev/commands), [files](https://docs.e2b.dev/filesystem/read-write), [preview access](https://docs.e2b.dev/network/restrict-public-access), and [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).
