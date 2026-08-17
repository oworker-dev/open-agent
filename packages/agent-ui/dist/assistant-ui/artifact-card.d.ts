import type { ComponentProps, ReactNode } from "react";
export declare function ArtifactCard({ className, icon, meta, title, ...props }: Omit<ComponentProps<"button">, "children" | "title"> & {
    readonly icon?: ReactNode;
    readonly meta: string;
    readonly title: string;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=artifact-card.d.ts.map