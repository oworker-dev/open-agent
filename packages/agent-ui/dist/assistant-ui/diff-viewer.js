"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo, useRef } from "react";
import { cva } from "class-variance-authority";
import { diffLines } from "diff";
import parseDiff from "parse-diff";
import { cn } from "../utils.js";
function parsePatch(patch) {
    let files;
    try {
        files = parseDiff(patch);
    }
    catch {
        return [];
    }
    return files.map((file) => {
        const lines = [];
        let additions = 0;
        let deletions = 0;
        for (const chunk of file.chunks) {
            let oldLine = chunk.oldStart;
            let newLine = chunk.newStart;
            for (const change of chunk.changes) {
                if (change.type === "add") {
                    additions++;
                    lines.push({
                        type: "add",
                        content: change.content.slice(1),
                        newLineNumber: newLine++,
                    });
                }
                else if (change.type === "del") {
                    deletions++;
                    lines.push({
                        type: "del",
                        content: change.content.slice(1),
                        oldLineNumber: oldLine++,
                    });
                }
                else {
                    lines.push({
                        type: "normal",
                        content: change.content.slice(1),
                        oldLineNumber: oldLine++,
                        newLineNumber: newLine++,
                    });
                }
            }
        }
        return {
            oldName: file.from,
            newName: file.to,
            lines,
            additions,
            deletions,
        };
    });
}
function computeDiff(oldContent, newContent) {
    const changes = diffLines(oldContent, newContent);
    const lines = [];
    let oldLine = 1;
    let newLine = 1;
    let additions = 0;
    let deletions = 0;
    for (const change of changes) {
        const contentLines = change.value.replace(/\n$/, "").split("\n");
        for (const content of contentLines) {
            if (change.added) {
                additions++;
                lines.push({ type: "add", content, newLineNumber: newLine++ });
            }
            else if (change.removed) {
                deletions++;
                lines.push({ type: "del", content, oldLineNumber: oldLine++ });
            }
            else {
                lines.push({
                    type: "normal",
                    content,
                    oldLineNumber: oldLine++,
                    newLineNumber: newLine++,
                });
            }
        }
    }
    return { lines, additions, deletions };
}
function pairLinesForSplit(lines) {
    const pairs = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.type === "normal") {
            pairs.push({ left: line, right: line });
            i++;
        }
        else if (line.type === "del") {
            const deletions = [];
            while (i < lines.length && lines[i].type === "del") {
                deletions.push(lines[i]);
                i++;
            }
            const additions = [];
            while (i < lines.length && lines[i].type === "add") {
                additions.push(lines[i]);
                i++;
            }
            const maxLen = Math.max(deletions.length, additions.length);
            for (let j = 0; j < maxLen; j++) {
                pairs.push({
                    left: deletions[j] ?? null,
                    right: additions[j] ?? null,
                });
            }
        }
        else {
            pairs.push({ left: null, right: line });
            i++;
        }
    }
    return pairs;
}
const diffViewerVariants = cva("aui-diff-viewer overflow-hidden rounded-lg font-mono text-sm", {
    variants: {
        variant: {
            default: "bg-background border",
            ghost: "bg-transparent",
            muted: "border-muted-foreground/20 bg-muted border",
        },
        size: {
            sm: "text-xs",
            default: "text-sm",
            lg: "text-base",
        },
    },
    defaultVariants: {
        variant: "default",
        size: "default",
    },
});
const diffLineVariants = cva("flex min-w-max", {
    variants: {
        type: {
            add: "bg-[var(--diff-add-bg,_rgba(46,160,67,0.15))]",
            del: "bg-[var(--diff-del-bg,_rgba(248,81,73,0.15))]",
            normal: "",
            empty: "",
        },
    },
    defaultVariants: {
        type: "normal",
    },
});
const diffLineTextVariants = cva("", {
    variants: {
        type: {
            add: "text-[var(--diff-add-text,_#1a7f37)] dark:text-[var(--diff-add-text-dark,_#3fb950)]",
            del: "text-[var(--diff-del-text,_#cf222e)] dark:text-[var(--diff-del-text-dark,_#f85149)]",
            normal: "",
            empty: "",
        },
    },
    defaultVariants: {
        type: "normal",
    },
});
function getFileExtension(filename) {
    const ext = filename?.split(".").pop()?.toLowerCase();
    if (!ext)
        return "";
    return ext.toUpperCase();
}
function DiffViewerFileBadge({ filename }) {
    const ext = getFileExtension(filename);
    if (!ext)
        return null;
    return (_jsx("span", { "data-slot": "diff-viewer-file-badge", className: "bg-background inline-flex size-5 shrink-0 items-end justify-end rounded-sm border text-[8px] leading-none font-bold", children: _jsx("span", { className: "p-0.5", children: ext }) }));
}
function DiffViewerStats({ additions, deletions, }) {
    return (_jsxs("span", { "data-slot": "diff-viewer-stats", className: "flex gap-2 text-xs", children: [_jsxs("span", { className: "text-green-600 dark:text-green-400", children: ["+", additions] }), _jsxs("span", { className: "text-red-600 dark:text-red-400", children: ["-", deletions] })] }));
}
function DiffViewerFile({ className, ...props }) {
    return (_jsx("div", { "data-slot": "diff-viewer-file", className: cn(className), ...props }));
}
function DiffViewerContent({ className, ...props }) {
    return (_jsx("div", { "data-slot": "diff-viewer-content", className: cn("overflow-x-auto", className), ...props }));
}
function DiffViewerHeader({ oldName, newName, additions = 0, deletions = 0, showIcon = true, showStats = true, className, ...props }) {
    if (!oldName && !newName)
        return null;
    const displayName = newName || oldName;
    return (_jsxs("div", { "data-slot": "diff-viewer-header", className: cn("bg-muted text-muted-foreground flex items-center gap-2 border-b px-4 py-2", className), ...props, children: [showIcon && _jsx(DiffViewerFileBadge, { filename: displayName }), _jsx("span", { className: "flex-1", children: oldName && newName && oldName !== newName ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "text-red-600 dark:text-red-400", children: oldName }), " → ", _jsx("span", { className: "text-green-600 dark:text-green-400", children: newName })] })) : (displayName) }), showStats && (additions > 0 || deletions > 0) && (_jsx(DiffViewerStats, { additions: additions, deletions: deletions }))] }));
}
function DiffViewerLine({ line, showLineNumbers = true, className, ...props }) {
    const indicator = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
    return (_jsxs("div", { "data-slot": "diff-viewer-line", "data-type": line.type, className: cn(diffLineVariants({ type: line.type }), className), ...props, children: [showLineNumbers && (_jsx("span", { "data-slot": "diff-viewer-line-number", className: "text-muted-foreground w-12 shrink-0 px-2 text-end select-none", children: line.type === "del"
                    ? line.oldLineNumber
                    : line.type === "add"
                        ? line.newLineNumber
                        : line.oldLineNumber })), _jsx("span", { "data-slot": "diff-viewer-indicator", className: cn("w-4 shrink-0 text-center select-none", diffLineTextVariants({ type: line.type })), children: indicator }), _jsx("span", { "data-slot": "diff-viewer-content", className: cn("flex-1 whitespace-pre", diffLineTextVariants({ type: line.type })), children: line.content })] }));
}
function DiffViewerSplitLine({ pair, showLineNumbers = true, className, ...props }) {
    const { left, right } = pair;
    return (_jsxs("div", { "data-slot": "diff-viewer-split-line", className: cn("flex", className), ...props, children: [_jsxs("div", { "data-slot": "diff-viewer-split-left", "data-type": left?.type ?? "empty", className: cn("flex w-1/2 border-e", diffLineVariants({ type: left?.type ?? "empty" })), children: [showLineNumbers && (_jsx("span", { className: "text-muted-foreground w-12 shrink-0 px-2 text-end select-none", children: left?.oldLineNumber ?? "" })), _jsx("span", { className: cn("w-4 shrink-0 text-center select-none", diffLineTextVariants({ type: left?.type ?? "empty" })), children: left ? (left.type === "del" ? "-" : " ") : "" }), _jsx("span", { className: cn("flex-1 break-all whitespace-pre-wrap", diffLineTextVariants({ type: left?.type ?? "empty" })), children: left?.content ?? "" })] }), _jsxs("div", { "data-slot": "diff-viewer-split-right", "data-type": right?.type ?? "empty", className: cn("flex w-1/2", diffLineVariants({ type: right?.type ?? "empty" })), children: [showLineNumbers && (_jsx("span", { className: "text-muted-foreground w-12 shrink-0 px-2 text-end select-none", children: right?.newLineNumber ?? "" })), _jsx("span", { className: cn("w-4 shrink-0 text-center select-none", diffLineTextVariants({ type: right?.type ?? "empty" })), children: right ? (right.type === "add" ? "+" : " ") : "" }), _jsx("span", { className: cn("flex-1 break-all whitespace-pre-wrap", diffLineTextVariants({ type: right?.type ?? "empty" })), children: right?.content ?? "" })] })] }));
}
function DiffViewer({ code, patch, oldFile, newFile, viewMode = "unified", showLineNumbers = true, showIcon = true, showStats = true, variant, size, className, contentClassName, }) {
    const diffPatch = patch ?? code;
    const oldContent = oldFile?.content;
    const oldName = oldFile?.name;
    const newContent = newFile?.content;
    const newName = newFile?.name;
    const lastValidFilesRef = useRef([]);
    const parsedFiles = useMemo(() => {
        if (diffPatch) {
            const next = parsePatch(diffPatch);
            if (next.length > 0)
                lastValidFilesRef.current = next;
            return next.length > 0 ? next : lastValidFilesRef.current;
        }
        if (oldContent !== undefined && newContent !== undefined) {
            const { lines, additions, deletions } = computeDiff(oldContent, newContent);
            const next = [
                {
                    oldName,
                    newName,
                    lines,
                    additions,
                    deletions,
                },
            ];
            lastValidFilesRef.current = next;
            return next;
        }
        return [];
    }, [diffPatch, oldContent, oldName, newContent, newName]);
    const splitLinePairs = useMemo(() => {
        if (viewMode !== "split")
            return [];
        return parsedFiles.map((file) => pairLinesForSplit(file.lines));
    }, [parsedFiles, viewMode]);
    if (parsedFiles.length === 0) {
        return (_jsx("pre", { "data-slot": "diff-viewer", className: cn("bg-muted rounded-lg p-4", className), children: "No diff content provided" }));
    }
    return (_jsx("div", { "data-slot": "diff-viewer", "data-view-mode": viewMode, "data-variant": variant ?? "default", "data-size": size ?? "default", className: cn(diffViewerVariants({ variant, size }), className), children: parsedFiles.map((file, fileIndex) => (_jsxs("div", { "data-slot": "diff-viewer-file", className: "[contain-intrinsic-size:auto_240px] [content-visibility:auto]", children: [_jsx(DiffViewerHeader, { oldName: file.oldName, newName: file.newName, additions: file.additions, deletions: file.deletions, showIcon: showIcon, showStats: showStats }), _jsx("div", { "data-slot": "diff-viewer-content", className: cn("overflow-x-auto", contentClassName), children: viewMode === "split"
                        ? (splitLinePairs[fileIndex] ?? []).map((pair, pairIndex) => (_jsx(DiffViewerSplitLine, { pair: pair, showLineNumbers: showLineNumbers }, pairIndex)))
                        : file.lines.map((line, lineIndex) => (_jsx(DiffViewerLine, { line: line, showLineNumbers: showLineNumbers }, lineIndex))) })] }, fileIndex))) }));
}
DiffViewer.displayName = "DiffViewer";
export { DiffViewer, DiffViewerFile, DiffViewerHeader, DiffViewerContent, DiffViewerLine, DiffViewerSplitLine, DiffViewerFileBadge, DiffViewerStats, diffViewerVariants, diffLineVariants, diffLineTextVariants, parsePatch, computeDiff, };
//# sourceMappingURL=diff-viewer.js.map