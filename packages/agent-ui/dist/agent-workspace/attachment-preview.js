"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from "react";
import { CodeXmlIcon, FileIcon, FilmIcon, GlobeIcon, ImageIcon, LoaderCircleIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { Attachment, AttachmentTrigger } from "../ui/attachment.js";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../ui/dialog.js";
import { cn } from "../utils.js";
import { useAssetPreview } from "./asset-preview.js";
export function AttachmentFileIcon({ filename, mediaType, preview = false, className }) {
    const html = mediaType?.startsWith("text/html") || /\.html?$/iu.test(filename);
    const video = mediaType?.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/iu.test(filename);
    const code = /\.(?:[cm]?[jt]sx?|json|css|py|sh|sql|ya?ml)$/iu.test(filename);
    const Icon = html ? preview ? GlobeIcon : CodeXmlIcon : video && preview ? FilmIcon : code ? CodeXmlIcon : FileIcon;
    return _jsx(Icon, { "aria-hidden": true, className: cn("size-4 shrink-0 text-muted-foreground", video && preview && "text-violet-500", className) });
}
export function AttachmentImagePreview({ children, className, dismissLabel = "Close", label, name, retryLabel, source, state = "done", title }) {
    const preview = useAssetPreview(source);
    const [open, setOpen] = useState(false);
    const [failedUrl, setFailedUrl] = useState();
    const [attempt, setAttempt] = useState(0);
    const failed = Boolean(preview.error || preview.url && failedUrl === preview.url);
    const retry = () => { setFailedUrl(undefined); setAttempt(value => value + 1); preview.retry(); };
    return _jsxs(_Fragment, { children: [_jsxs(Attachment, { className: cn("size-25 min-w-0 overflow-hidden rounded-lg border-0 bg-muted p-0", className), "data-attachment-kind": "image", orientation: "vertical", state: failed ? "error" : state, title: title ?? name, children: [preview.url && !failed ? _jsx("img", { alt: name, className: "block size-full object-cover", onError: () => setFailedUrl(preview.url), src: preview.url }, attempt)
                        : _jsx("div", { className: "flex size-full items-center justify-center text-muted-foreground", children: !failed && (state === "processing" || state === "uploading") ? _jsx(LoaderCircleIcon, { className: "size-5 animate-spin" }) : failed ? _jsx(RotateCcwIcon, { className: "size-5" }) : _jsx(ImageIcon, { className: "size-5" }) }), failed ? _jsx(AttachmentTrigger, { "aria-label": `${retryLabel}: ${name}`, onClick: retry, title: preview.error ?? retryLabel })
                        : preview.url ? _jsx(AttachmentTrigger, { "aria-label": label, className: "cursor-zoom-in", onClick: () => setOpen(true) }) : null, children] }), _jsx(Dialog, { open: open && Boolean(preview.url) && !failed, onOpenChange: setOpen, children: _jsxs(DialogContent, { "aria-describedby": undefined, className: "min-h-12 w-fit min-w-12 max-w-[calc(100vw-2rem)] place-items-center overflow-hidden border-0 bg-background p-0 shadow-2xl sm:max-w-[calc(100vw-3rem)]", showCloseButton: false, children: [_jsx(DialogTitle, { className: "sr-only", children: name }), _jsx("img", { alt: name, className: "block max-h-[85vh] max-w-full object-contain", src: preview.url }), _jsx(DialogClose, { "aria-label": dismissLabel, className: "absolute right-2 top-2 flex size-7 items-center justify-center rounded-full border bg-background/90 text-foreground shadow-sm focus-visible:ring-2 focus-visible:ring-ring", children: _jsx(XIcon, { className: "size-4" }) })] }) })] });
}
//# sourceMappingURL=attachment-preview.js.map