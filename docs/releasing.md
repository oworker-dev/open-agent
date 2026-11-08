# Release Runbook

The repository publishes immutable GitHub prerelease artifacts while the npm
packages remain private. A license and stable public package policy are separate
product-owner decisions; do not infer them from this automation.

## Version Policy

- Use SemVer prerelease versions such as `0.1.0-alpha.5`.
- Keep the root, all SDK workspaces, public version constants, examples, tests,
  and host dependency URLs on the same alpha version.
- Never move or reuse a published tag. A correction receives a new version.
- Protocol compatibility is explicit in contracts; matching package versions
  do not authorize an incompatible protocol change.

## Release Procedure

1. Build and commit SDK distributions first (`npm run build:sdk`), then run
   `AGENT_EMBED_ALLOWED_ORIGINS=https://host.example.invalid EVE_NEXT_PRODUCTION_PORT=4275 npm run verify:ci`
   under Node.js 24. The source-distribution check requires committed build
   output and a clean distribution tree. Include the mailbox unit and
   browser gates for strict FIFO, persisted recovery, failed-delivery retry,
   cancellation, ambiguous-admission commit reconciliation, orphaned sub-agent
   terminal states, and child-session navigation/recovery.
2. Review dependency changes, generated declarations, package contents, and the
   secret scan. Confirm no `.env`, credentials, test databases, traces, or user
   artifacts are tracked.
3. Commit and push `main`; require the CI workflow to pass.
4. Create and push an annotated tag matching `v<package.json version>`.
5. The prerelease workflow rebuilds from the tag, verifies the version, packs
   all five SDKs, emits `SHA256SUMS`, uploads artifacts, and requests GitHub
   build-provenance attestations.
6. A separate release job builds `sandbox/Dockerfile`, publishes version and
   `v`-prefixed tags to `ghcr.io/<owner>/open-agent-sandbox`, runs the runtime
   probe against the returned immutable digest, emits an SBOM, and requests a
   registry provenance attestation.
7. Verify the release assets, image digest, SBOM, and attestations, then update
   deployment and host references in a separate reviewed commit. Do not point a
   host at an artifact or mutable image tag before the release exists.

For the deterministic browser gate, start the development server with the
browser job's environment, including its fixture `AGENT_DATABASE_URL`. The URL
selects HTTP storage and mailbox; Playwright intercepts those endpoints, so it
does not require a PostgreSQL service. Omitting it selects localStorage and
bypasses the server persistence, steering, and cancellation behavior under test.
Keep Strict Mode enabled: scope initialization may load twice in development,
while same-scope token renewal must not add collection loads in either mode.

Before publishing a sandbox image, confirm that the GHCR package is connected
to `oworker-dev/open-agent` and inherits repository permissions, or explicitly
grants this repository Actions write access. A pre-existing package published
with a personal token does not automatically grant `GITHUB_TOKEN` access.
The Dockerfile's `org.opencontainers.image.source` label identifies the source
repository; when bootstrapping an unlinked package, publish this metadata with
an owner credential under a separate tag, without moving release tags. Keep
the workflow using `GITHUB_TOKEN`; do not store the owner token in the repo.

Do not treat tag push or workflow startup as a successful release. Wait for
both main CI jobs, the image runtime probe, and the prerelease job to succeed,
then verify all five SDK archives, `SHA256SUMS`, and provenance. Failed tags
remain immutable; corrections use the next prerelease version.

The deployment manifest must include the mailbox worker alongside Agent Web and
Eve. Release smoke checks must prove that a follow-up submitted while a turn is
running survives a page close, is delivered only at `session.waiting`, produces
one durable `message.received`, and does not call the browser's Eve continuation
route. A successful Web build without the worker is incomplete for hosts that
enable follow-ups.

The workflow does not publish to npm. Removing `private: true`, selecting a
license, setting npm provenance, and defining stable support/migration policy
require an explicit release decision.
