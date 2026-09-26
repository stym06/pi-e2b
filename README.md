# E2B sandbox extension for Pi

Run Pi locally while its coding tools execute in an [E2B](https://docs.e2b.dev/) sandbox. Sessions resume the same sandbox; forks get their own copy. Each session works on a `pi/<session-hash>` Git branch.

## Install

Requires Node.js 22+, Pi, and an E2B API key.

```sh
npm install -g @earendil-works/pi-coding-agent
pi install npm:pi-e2b
export E2B_API_KEY="your-e2b-api-key"
```

To install directly from the latest GitHub `main` instead, run `pi install git:github.com/stym06/pi-e2b`.

## Use a repository

From a local Git checkout, run:

```sh
cd /path/to/project
pi --e2b
```

Pi clones that checkout's `origin` and current branch into the sandbox. Local uncommitted changes and commits that haven't been pushed are not copied.

To use a different remote repository, run:

```sh
pi --e2b --repo https://github.com/owner/project.git
```

`--repo` also accepts SSH URLs such as `git@github.com:owner/project.git`; they are converted to HTTPS for cloning. Add `--e2b-branch <name>` to choose a branch, or use `--e2b-no-repo` for an empty workspace.

For private GitHub repositories, pushes, and pull requests, log in on your host with `gh auth login --hostname github.com`. You can use `E2B_GIT_TOKEN` instead; creating a PR with a fine-grained token also needs **Pull requests: Read and write** permission.

## Commands

| Command | Action |
| --- | --- |
| `/e2b` | Show sandbox status and session branch |
| `/e2b pause` | Pause the sandbox |
| `/e2b resume` | Reconnect to the sandbox |
| `/e2b push` | Push committed changes on the current branch |
| `/e2b pr [base] [--draft]` | Push commits and create or find a GitHub PR |
| `/e2b url <port>` | Show a service preview URL |
| `/e2b kill --yes` | Permanently delete the sandbox |
| `/e2b new` | Create a new sandbox after deletion |

Commit changes before pushing or creating a PR. Saved sessions pause on exit and remain paused until resumed or deleted. Resume with `pi --e2b --continue`.
