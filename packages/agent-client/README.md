# @oworker/open-agent-client

Framework-neutral TypeScript client for the Headless AgentRun HTTP contract.

The package supports dynamic short-lived bearer tokens, idempotent run starts,
incremental event cursors, inspection, cancellation, structured HTTP errors,
and response contract validation. It has no React or Muses product dependency.

The root entry point exports only the framework-neutral AgentRun and session-control
clients. It never loads Eve.

`@oworker/open-agent-client/eve-session` is the explicit Eve 0.31.x adapter for
the host-neutral AgentSession cursor, streaming, stable-ID follow-ups,
cancellation, and reset interfaces. Eve is an optional peer dependency so
Headless AgentRun hosts do not install a Harness client they do not use.
