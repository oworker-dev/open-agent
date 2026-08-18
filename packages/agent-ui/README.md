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

`deliverableEndpoint` may be a URL template or `(sessionId) => url` resolver
returning `{ deliverables: [...] }`. `onOpenDeliverable` can hand a published
file or website to a host-owned workbench. Without an override, the default UI
uses the Open Agent service's owner-scoped `/api/deliverables` registry and its
signed result URLs. Reusable assistant-ui elements are exported from
`@oworker/open-agent-ui/assistant-ui/*` for native host composition.
