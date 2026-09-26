# Publishing pi-e2b

The [publish workflow](.github/workflows/publish.yml) runs for every push to `main` after the repository variable `NPM_PUBLISH_ENABLED` is set to `true`. It checks the package, increments the latest npm patch version in its checkout, and publishes through npm trusted publishing. After publishing succeeds, it creates a GitHub Release and a `v<version>` tag pointing to the exact commit used by that run, with generated release notes and a link to the npm version. The generated package version is not committed back to Git, so the source archive retains the version in the repository. You can also run it manually from GitHub Actions.

Release creation uses the workflow's built-in `GITHUB_TOKEN` with `contents: write`; no extra secret is needed. Packages are hosted on npm, so GitHub's **Packages** section remains empty. Published versions appear in GitHub's **Releases** section.

One-time setup for the package owner:

1. Sign in to npm with an account that can publish the unscoped `pi-e2b` name. From a clean clone of `main`, run `npm login`, `npm ci`, `npm run check`, `npm pack --dry-run`, and `npm publish --access public` to create version `0.1.0`. Publishing may require npm two-factor authentication.
2. On the npm page for `pi-e2b`, add a **Trusted Publisher** for GitHub Actions: owner `stym06`, repository `pi-e2b`, workflow filename `publish.yml`, and allow direct `npm publish`. Leave the optional environment name empty. No npm token needs to be stored in GitHub.
3. In GitHub repository **Settings → Secrets and variables → Actions → Variables**, create `NPM_PUBLISH_ENABLED` with value `true`. Run **Publish to npm** manually once for the current `main` commit; later pushes to `main` publish automatically.

Once published, install with `pi install npm:pi-e2b`. The `pi-package` keyword makes the npm release eligible for the [Pi package gallery](https://pi.dev/packages). Pi indexes npm releases; there is no separate upload to Pi.
