# @oworker/open-agent-contracts

Versioned, host-neutral TypeScript contracts for AgentRun, Agent embed, and
Host Capability integrations.

This package contains no Agent runtime, React UI, provider, database, or Muses
canvas implementation. It remains private while the repository-wide open-source
license decision is pending.

The `runtime-config` contract includes credential-free, versioned host extension
metadata. Skills may carry a standard `SKILL.md` plus bounded relative text or
base64 files; the Open Agent runtime materializes those files only in the
corresponding Eve session sandbox. Runtime Config cannot inject tools, MCP
adapters, credentials, network access, or approval authority. Hosts should keep
inline packages small because the snapshot may travel in authenticated session
attributes or a JWT; larger packages should use an immutable object-store
reference when that transport is added.
