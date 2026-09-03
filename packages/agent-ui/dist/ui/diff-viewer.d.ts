import { type ComponentProps } from "react";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { type VariantProps } from "class-variance-authority";
type DiffLineType = "add" | "del" | "normal";
interface ParsedLine {
    type: DiffLineType;
    content: string;
    oldLineNumber?: number;
    newLineNumber?: number;
}
interface ParsedFile {
    oldName?: string | undefined;
    newName?: string | undefined;
    lines: ParsedLine[];
    additions: number;
    deletions: number;
}
interface SplitLinePair {
    left: ParsedLine | null;
    right: ParsedLine | null;
}
declare function parsePatch(patch: string): ParsedFile[];
declare function computeDiff(oldContent: string, newContent: string): {
    lines: ParsedLine[];
    additions: number;
    deletions: number;
};
declare const diffViewerVariants: (props?: ({
    variant?: "default" | "ghost" | "muted" | null | undefined;
    size?: "default" | "sm" | "lg" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
declare const diffLineVariants: (props?: ({
    type?: "del" | "normal" | "add" | "empty" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
declare const diffLineTextVariants: (props?: ({
    type?: "del" | "normal" | "add" | "empty" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
declare function DiffViewerFileBadge({ filename }: {
    filename?: string | undefined;
}): import("react/jsx-runtime").JSX.Element | null;
declare function DiffViewerStats({ additions, deletions, }: {
    additions: number;
    deletions: number;
}): import("react/jsx-runtime").JSX.Element;
declare function DiffViewerFile({ className, ...props }: ComponentProps<"div">): import("react/jsx-runtime").JSX.Element;
declare function DiffViewerContent({ className, ...props }: ComponentProps<"div">): import("react/jsx-runtime").JSX.Element;
interface DiffViewerHeaderProps extends ComponentProps<"div"> {
    oldName?: string | undefined;
    newName?: string | undefined;
    additions?: number;
    deletions?: number;
    showIcon?: boolean;
    showStats?: boolean;
}
declare function DiffViewerHeader({ oldName, newName, additions, deletions, showIcon, showStats, className, ...props }: DiffViewerHeaderProps): import("react/jsx-runtime").JSX.Element | null;
interface DiffViewerLineProps extends ComponentProps<"div"> {
    line: ParsedLine;
    showLineNumbers?: boolean;
}
declare function DiffViewerLine({ line, showLineNumbers, className, ...props }: DiffViewerLineProps): import("react/jsx-runtime").JSX.Element;
interface DiffViewerSplitLineProps extends ComponentProps<"div"> {
    pair: SplitLinePair;
    showLineNumbers?: boolean;
}
declare function DiffViewerSplitLine({ pair, showLineNumbers, className, ...props }: DiffViewerSplitLineProps): import("react/jsx-runtime").JSX.Element;
export type DiffViewerProps = Partial<SyntaxHighlighterProps> & VariantProps<typeof diffViewerVariants> & {
    patch?: string;
    oldFile?: {
        content: string;
        name?: string;
    };
    newFile?: {
        content: string;
        name?: string;
    };
    viewMode?: "split" | "unified";
    showLineNumbers?: boolean;
    showIcon?: boolean;
    showStats?: boolean;
    className?: string;
};
declare function DiffViewer({ code, patch, oldFile, newFile, viewMode, showLineNumbers, showIcon, showStats, variant, size, className, }: DiffViewerProps): import("react/jsx-runtime").JSX.Element;
declare namespace DiffViewer {
    var displayName: string;
}
export type { ParsedLine, ParsedFile, SplitLinePair };
export { DiffViewer, DiffViewerFile, DiffViewerHeader, DiffViewerContent, DiffViewerLine, DiffViewerSplitLine, DiffViewerFileBadge, DiffViewerStats, diffViewerVariants, diffLineVariants, diffLineTextVariants, parsePatch, computeDiff, };
//# sourceMappingURL=diff-viewer.d.ts.map