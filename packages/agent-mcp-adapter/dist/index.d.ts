import type { SessionContext } from "eve/context";
import { z } from "zod";
export type ServiceTokenResolver = () => string | Promise<string>;
declare const adapterConfigSchema: z.ZodObject<{
    adapter: z.ZodObject<{
        id: z.ZodString;
        version: z.ZodString;
    }, z.core.$strict>;
    broker: z.ZodObject<{
        getServiceToken: z.ZodCustom<ServiceTokenResolver, ServiceTokenResolver>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
        url: z.ZodString;
    }, z.core.$strict>;
    connection: z.ZodObject<{
        description: z.ZodString;
        displayName: z.ZodString;
        endpoint: z.ZodString;
        tools: z.ZodObject<{
            allow: z.ZodArray<z.ZodString>;
            requireApproval: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type McpAdapterConfig = z.input<typeof adapterConfigSchema>;
export type AdapterRef = {
    readonly id: string;
    readonly version: string;
};
export type CredentialBrokerSubject = {
    readonly actorType: string;
    readonly principalId: string;
    readonly tenantId: string;
};
export type CredentialBrokerRequest = {
    readonly adapter: AdapterRef;
    readonly contractVersion: "0.1.0";
    readonly sessionId: string;
    readonly subject: CredentialBrokerSubject;
};
export declare function createBrokeredMcpConnection(input: McpAdapterConfig): import("eve/connections").McpClientConnectionDefinition;
export declare function authorizeMcpSession(ctx: SessionContext, adapter: AdapterRef): CredentialBrokerRequest;
export declare function approvalForMcpTool(qualifiedToolName: string, toolsRequiringApproval: readonly string[]): "not-applicable" | "user-approval";
export declare function resolveBrokeredCredential(input: {
    readonly getServiceToken: ServiceTokenResolver;
    readonly request: CredentialBrokerRequest;
    readonly timeoutMs: number;
    readonly url: string;
}): Promise<{
    readonly expiresAt?: number;
    readonly token: string;
}>;
export {};
//# sourceMappingURL=index.d.ts.map