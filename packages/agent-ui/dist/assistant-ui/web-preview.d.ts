import type { ComponentProps, ReactNode } from "react";
export declare function WebPreview({ children, className, loading, onOpenExternal, onReload, origin, ...props }: Omit<ComponentProps<"div">, "children"> & {
    readonly children: ReactNode;
    readonly loading: boolean;
    readonly onOpenExternal?: () => void;
    readonly onReload?: () => void;
    readonly origin: string;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=web-preview.d.ts.map