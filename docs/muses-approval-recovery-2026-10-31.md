# Muses approval recovery after Eve 0.85

The Muses host reproduced an approval that returned HTTP 202 but never wrote
to its creative canvas. The original synthetic session was
`wrun_01M68VPQFZWG6HW5EM50NY06HX`.

The mailbox dispatcher deferred its structured response 216 times before
admission because a paused HITL turn remains active. Responses now pass the
active-turn gate, as they already do at the signed Eve channel. Ordinary sends
and edits still wait, steering still requires the exact active turn, and a
terminal session cannot resume.

After admission was restored, Eve refused the response because the mailbox
snapshot replaced `host-jwt` with `agent-mailbox-dispatch`. Snapshots now retain
the verified caller's authenticator as well as issuer, principal type, principal
id and Host subject. A separate internal attribute identifies mailbox delivery
for bookkeeping. Ownership checks and Eve's default approval responder check
remain in force; browser body fields cannot supply caller identity.

The UI also treated a committed mailbox response as an approval decision even
when `response.settled` refused it. It now correlates the response with its
interaction and submission cursor, removes the optimistic answer on refusal,
shows the reason, and restores controls for the still-open interaction. An old
refusal does not invalidate a later attempt. Transport admission remains distinct
from the actual decision in `interaction.settled`.

The original tool call subsequently completed and wrote one node, but its final
reply failed because the historical policy charged more than 20 minutes of
human approval waiting against `maxDurationMs`. The policy now meters cumulative
active execution segments. `turn.paused` and `turn.settled` stop the clock;
consumed deliveries and new model/tool/turn boundaries resume it. Hook timestamps
come from the durable event context. Token, call and turn counters stay intact.
Legacy checkpoints adopt the clock at their next observed boundary while
retaining those counters; their past active duration cannot be reconstructed
from the old session-start timestamp alone.

Targeted regression coverage includes 72 passing cases across run policy, mailbox service,
runtime transport, session auth, boundary inspection, HTTP dispatch and thread
storage. Identity coverage calls Eve's installed `sameResponder` implementation
and checks that another authenticator, issuer, principal type or user still
fails. End-to-end browser outcomes are recorded in the Muses repository under
`delivery/evidence/creator-platform-usability-20261029/agent-recovery-20261031/`.

Deployment must preserve `.eve/production-preview-host-jwt-secret` and
`.eve/production-preview-signing-secret`. They are persistent runtime identity,
not compiler caches. Replacing the build directory without those files rotates
the service identity and breaks existing Host tokens. A deployment verification
must include authenticated collection access, not only the public health route.

The follow-up public HTTP browser gate also reproduced image thumbnails returning
403 after send and reload, although upload and real model vision had succeeded.
An img element cannot carry the Host authorization header. The workspace now
provides an authenticated preview context: protected image assets are fetched
with current client credentials, restricted to the configured service's asset
endpoint with redirects forbidden, then rendered from an ephemeral Blob URL.
Requests abort and object URLs are revoked when their consumer unmounts. Preview
reads are bounded to 32 MiB and executable document content is rejected. Tokens
are never put into resource URLs or persisted conversation state.

Eight additional attachment tests cover upload behavior and preview credential
boundaries, rotation, refusal, cancellation and size limits; production Next,
UI package and type checks pass. Public HTTP browser acceptance verifies upload,
real vision, refresh, image preview and a follow-up about the same image. The
original broken image session also recovers without reuploading its asset.
Non-image file previews/downloads and broader large-file behavior remain
separate acceptance work.
