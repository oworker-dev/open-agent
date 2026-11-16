# @oworker/open-agent-ui

Reusable assistant-ui React workspace for the independent Open Agent service.
The package owns presentation and durable Eve session projection, but
does not own host identity, model entitlement, billing, or host business state.

Import the precompiled stylesheet once in the host application:

```css
@import "@oworker/open-agent-ui/styles.css";
```

Then inject the host-reviewed model catalog and defaults:

```tsx
import { AgentWorkspace } from "@oworker/open-agent-ui";

export function AgentPage() {
  return (
    <AgentWorkspace
      agentName="general-agent"
      deliverableEndpoint="/host/agent-deliverables"
      commands={[{ id: "software-task", label: "Software task", value: "/software-task" }]}
      defaultPreferences={{ modelId: "provider/model", reasoning: "high" }}
      client={{
        // Embedded hosts can return a short-lived signed URL. The standalone
        // app omits this and uses its authenticated /api/assets route.
        assetUrl: (assetId) => `/host/assets/${encodeURIComponent(assetId)}`,
      }}
      extensions={[{ id: "software-task", kind: "skill", label: "Software task", status: "available" }]}
      mentions={[{ id: "workspace", label: "Workspace", value: "@workspace" }]}
      models={[{ id: "provider/model", label: "Model", contextWindowTokens: 272000 }]}
      productName="Agent"
      reasoningLevels={["low", "medium", "high"]}
    />
  );
}
```

The default Web UI is built from assistant-ui primitives and the Eve adapter.
`commands`, `mentions`, and `extensions` are host-injected catalogs; Muses
canvas concepts never become a dependency of this package. Hosts can use the
default UI, replace tool renderers, or omit this package and use
`@oworker/open-agent-client/eve-session` directly.

On initial load, the workspace restores a valid `initialThreadId`, otherwise
the saved active thread (or the first existing thread). An empty collection
opens a temporary new task. Pass `initialThreadId={null}` when a host route
explicitly means “new task”; the standalone `/` route uses this behavior.
Keep client and storage adapters stable within the same service/account scope,
and read rotating credentials from their request callbacks.

New messages use normal bottom-follow scrolling. The first execution group in
a newly submitted response smoothly moves its user message to the top once;
reasoning alone does not trigger this. Scrolling to read history opts out of
that movement. Streaming, group collapse and replay do not repeat it, and each
same-turn follow-up has its own scroll boundary.

`deliverableEndpoint` may be a URL template or `(sessionId) => url` resolver
returning `{ deliverables: [...] }`. `onOpenDeliverable` can hand a published
file or website to a host-owned workbench. Without an override, the default UI
uses the Open Agent service's owner-scoped `/api/deliverables` registry and its
signed result URLs. Reusable assistant-ui elements are exported from
`@oworker/open-agent-ui/assistant-ui/*` for native host composition.

Pass `toolRenderers` to `AgentWorkspace` to customize individual tool calls:

```tsx
import {
  AgentWorkspace,
  type AgentToolRendererProps,
  type AgentToolRenderers,
} from "@oworker/open-agent-ui";

function HostOperation({ part, defaultContent }: AgentToolRendererProps) {
  // Preserve the default approval/question interaction when one is attached.
  if (part.interaction) return defaultContent;
  return (
    <section aria-label="Host operation">
      <strong>{part.label} · {part.state}</strong>
      <pre>{part.state === "streaming"
        ? part.inputText
        : JSON.stringify(part.error ?? part.output ?? part.input, null, 2)}</pre>
    </section>
  );
}

// Keep component types stable so streamed updates preserve local React state.
const toolRenderers: AgentToolRenderers = { host_invoke: HostOperation };

// Add to the workspace props in the example above:
// <AgentWorkspace {...workspaceProps} toolRenderers={toolRenderers} />
```

Keys match exact tool names, including MCP namespaces. An unspecified tool
retains its default UI. `defaultContent` renders the entire default call or
interaction, so a custom component can wrap it or fall back to it. The same
renderers apply to root and child session views; standalone `AgentMessage`
also accepts `toolRenderers`.

`part.callId` is the stable call identity. `part.inputText` contains merged
streaming arguments; after input completes, `part.input`, `part.output`,
`part.error`, and `part.state` carry the existing Eve projection. Progress
snapshots replace earlier progress and the final output replaces progress.
The extension introduces no independent stream or message state.

Custom interaction UIs receive `canRespond`, `inputRequestClosed`,
`onInputResponses`, and `onCloseInputRequest`. Use the interaction's existing
`interactionId` when responding, and honor read-only/closed states. Navigation
callbacks, `assetUrl`, locale, and the current message's events are also passed
through. These callbacks use the workspace's existing submission and persistence
path. Returning `defaultContent` retains the supplied ask/approval behavior.

The built-in `ask_question` UI supports `multiple: true` for non-exclusive
choices. Custom renderers can read that flag from `part.input`; the shared
`encodeMultiSelectAnswer` and `parseMultiSelectAnswer` helpers are exported by
`@oworker/open-agent-contracts` for storing and restoring the selected option IDs
through Eve's standard text answer field.

Renderers are React components supplied locally by the host. They do not belong
in serialized Runtime Config or cross-origin iframe messages. Tool authorization
remains a server policy (`profile.allowedTools`, `profile.defaultTools`,
`policy.tools`), independent of how a call is displayed.
