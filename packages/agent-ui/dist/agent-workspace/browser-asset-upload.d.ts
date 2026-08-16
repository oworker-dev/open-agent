import type { AgentAssetUploadAdapter, AgentWorkspaceClientConfig } from "./contracts.js";
import type { AttachmentAdapter } from "@assistant-ui/react";
export declare function createBrowserAttachmentAdapter(uploadAdapter: AgentAssetUploadAdapter, sessionId: () => string | undefined): AttachmentAdapter;
export declare function createHttpAgentAssetUploadAdapter(config: AgentWorkspaceClientConfig | undefined): AgentAssetUploadAdapter;
//# sourceMappingURL=browser-asset-upload.d.ts.map