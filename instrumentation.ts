import { registerOTel } from "@vercel/otel";

export async function register(): Promise<void> {
  registerOTel({
    serviceName: "open-agent-web",
    instrumentationConfig: {
      fetch: {
        propagateContextUrls: configuredOrigins([
          process.env.AGENT_RUNTIME_URL,
          process.env.AGENT_HOST_TOOLS_URL,
        ]),
      },
    },
  });
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeRuntime } = await import("./instrumentation-node");
    registerNodeRuntime();
  }
}

function configuredOrigins(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.flatMap((value) => {
    if (!value?.trim()) return [];
    try {
      return [new URL(value).origin];
    } catch {
      return [];
    }
  }))];
}
