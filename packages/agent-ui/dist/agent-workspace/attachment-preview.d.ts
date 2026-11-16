import { type ReactNode } from "react";
export declare function AttachmentFileIcon({ filename, mediaType, preview, className }: {
    readonly filename: string;
    readonly mediaType?: string;
    readonly preview?: boolean;
    readonly className?: string;
}): import("react/jsx-runtime").JSX.Element;
export declare function AttachmentImagePreview({ children, className, dismissLabel, label, name, retryLabel, source, state, title }: {
    readonly children?: ReactNode;
    readonly className?: string;
    readonly dismissLabel?: string;
    readonly label: string;
    readonly name: string;
    readonly retryLabel: string;
    readonly source?: string;
    readonly state?: "done" | "uploading" | "processing" | "error";
    readonly title?: string;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=attachment-preview.d.ts.map