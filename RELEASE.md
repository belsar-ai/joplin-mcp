# Release Process

This document outlines the process for creating new releases of `@belsar-ai/joplin-mcp`.

## TL;DR

- **For a simple patch/minor/major release from `main`:**
  1. Ensure `main` is up-to-date and stable.
  2. Run `make release-patch`, `make release-minor`, or `make release-major`.
  3. Run `git push origin main --tags`.

- **For a beta release from `main`:**
  1. Ensure `main` has the features you want to test.
  2. Run `make release-beta`.
  3. Run `git push origin main --tags`.

## Release Strategy

This project uses a release strategy based on industry best practices like [Git Flow](https://www.atlassian.com/git/tutorials/comparing-workflows/gitflow-workflow). Releases are automated using `npm version` scripts and a GitHub Actions workflow.

### Dependency security policy

Development and CI use the npm version pinned in `package.json`. The project-level `.npmrc` requires dependency releases to be at least seven days old, and treats unreviewed dependency install scripts as errors. When updating dependencies, npm therefore selects the newest compatible versions outside the cooling period.

Install the pinned package manager before entering the repository (older npm versions are intentionally rejected inside it):

```bash
npm install --global npm@12.0.2 --ignore-scripts
```

Urgent security fixes blocked by the cooling period require a temporary, package-specific `min-release-age-exclude` entry. Review and remove the exception in the same change.

### Versioning with Makefile

All versioning is handled by the Makefile targets which call the `scripts/release.sh` script. These commands automatically update the `package.json` version, create a new commit, and create a new git tag.

- `make release-patch`: For bug fixes (e.g., `v0.2.2` -> `v0.2.3`).
- `make release-minor`: For new features (e.g., `v0.2.2` -> `v0.3.0`).
- `make release-major`: For breaking changes (e.g., `v0.2.2` -> `v1.0.0`).
- `make release-beta`: For pre-releases (e.g., `v0.2.2` -> `v0.2.3-beta.0`).

### Automated Publishing

Publishing to npm is handled automatically by a GitHub Actions workflow. The workflow is triggered when a new tag matching the pattern `v*` is pushed to the repository.

- Tags containing "beta" (e.g., `v0.2.3-beta.0`) are published to the `beta` dist-tag on npm.
- All other tags are published to the `latest` dist-tag on npm.

### Promoting a Beta to a Stable Release

A stable release should always be created from a specific, well-tested commit that was previously a beta release. This ensures that only approved code is published as `latest`.

1.  **Identify the beta commit:** Find the tag of the beta you want to promote (e.g., `v0.3.0-beta.1`).

2.  **Checkout the beta tag:**

    ```bash
    git checkout v0.3.0-beta.1
    ```

3.  **Create the stable tag without the beta suffix:**

    ```bash
    git tag v0.3.0
    ```

4.  **Push the new tag to publish:**

    ```bash
    git push origin v0.3.0
    ```

This will trigger the GitHub Actions workflow to publish the stable release to npm with the `latest` tag.

## Pinned Dependencies

### `@anthropic-ai/sandbox-runtime`

This package is **pinned to an exact version** (no `^` or `~` prefix) because it is a pre-1.0 beta where even patch bumps can change sandbox behavior — e.g., default write paths, bwrap flags, seccomp filters. A silent change here could weaken or break our security boundary. The pinned version must also be outside the seven-day cooling period.

**Before each release**, check for new versions:

```bash
npm outdated @anthropic-ai/sandbox-runtime
```

If a new version is available:

1. Read the changelog / diff for security-relevant changes.
2. Update the version in `package.json` and run `npm install`.
3. Run the full test suite including integration tests (`npm test`).
4. Verify the sandbox smoke check still passes (broker rejects unwrapped commands).
5. Commit the update separately so it's easy to bisect if something breaks.
