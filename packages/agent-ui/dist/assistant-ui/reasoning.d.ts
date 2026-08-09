import { type VariantProps } from "class-variance-authority";
import { type ReasoningMessagePartComponent } from "@assistant-ui/react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
declare const reasoningVariants: (props?: ({
    variant?: "outline" | "ghost" | "muted" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export type ReasoningRootProps = Omit<React.ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> & VariantProps<typeof reasoningVariants> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
    streaming?: boolean;
};
declare function ReasoningRoot({ className, variant, open: controlledOpen, onOpenChange: controlledOnOpenChange, defaultOpen, streaming: _streaming, children, ...props }: ReasoningRootProps): import("react/jsx-runtime").JSX.Element;
declare function ReasoningFade({ side, className, ...props }: React.ComponentProps<"div"> & {
    side?: "top" | "bottom";
}): import("react/jsx-runtime").JSX.Element;
declare function ReasoningTrigger({ active, duration, hideChevron, label, className, ...props }: React.ComponentProps<typeof CollapsibleTrigger> & {
    active?: boolean;
    duration?: number;
    hideChevron?: boolean;
    label?: React.ReactNode;
}): import("react/jsx-runtime").JSX.Element;
declare function ReasoningContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>): import("react/jsx-runtime").JSX.Element;
declare function ReasoningText({ className, children, ...props }: React.ComponentProps<"div">): import("react/jsx-runtime").JSX.Element;
declare const Reasoning: ReasoningMessagePartComponent & {
    Root: typeof ReasoningRoot;
    Trigger: typeof ReasoningTrigger;
    Content: typeof ReasoningContent;
    Text: typeof ReasoningText;
    Fade: typeof ReasoningFade;
};
export { Reasoning, ReasoningRoot, ReasoningTrigger, ReasoningContent, ReasoningText, ReasoningFade, reasoningVariants, };
//# sourceMappingURL=reasoning.d.ts.map