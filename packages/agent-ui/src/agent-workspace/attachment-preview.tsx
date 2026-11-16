"use client";

import { useState, type ReactNode } from "react";
import { CodeXmlIcon, FileIcon, FilmIcon, GlobeIcon, ImageIcon, LoaderCircleIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { Attachment, AttachmentTrigger } from "../ui/attachment.js";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../ui/dialog.js";
import { cn } from "../utils.js";
import { useAssetPreview } from "./asset-preview.js";

export function AttachmentFileIcon({ filename, mediaType, preview = false, className }: {
  readonly filename: string;
  readonly mediaType?: string;
  readonly preview?: boolean;
  readonly className?: string;
}) {
  const html = mediaType?.startsWith("text/html") || /\.html?$/iu.test(filename);
  const video = mediaType?.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/iu.test(filename);
  const code = /\.(?:[cm]?[jt]sx?|json|css|py|sh|sql|ya?ml)$/iu.test(filename);
  const Icon = html ? preview ? GlobeIcon : CodeXmlIcon : video && preview ? FilmIcon : code ? CodeXmlIcon : FileIcon;
  return <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", video && preview && "text-violet-500", className)} />;
}

/** Fixed geometry keeps thumbnails independent of the generic file-icon styles. */
export function AttachmentImagePreview({ children, className, dismissLabel = "Close", label, name, retryLabel, source, state = "done", title }: {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly dismissLabel?: string;
  readonly label: string;
  readonly name: string;
  readonly retryLabel: string;
  readonly source?: string;
  readonly state?: "done" | "uploading" | "processing" | "error";
  readonly title?: string;
}) {
  const preview = useAssetPreview(source);
  const [open, setOpen] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const failed = Boolean(preview.error || preview.url && failedUrl === preview.url);
  const retry = () => { setFailedUrl(undefined); setAttempt(value => value + 1); preview.retry(); };
  return <>
    <Attachment className={cn("size-25 min-w-0 overflow-hidden rounded-lg border-0 bg-muted p-0", className)} data-attachment-kind="image" orientation="vertical" state={failed ? "error" : state} title={title ?? name}>
      {preview.url && !failed ? <img alt={name} className="block size-full object-cover" key={attempt} onError={() => setFailedUrl(preview.url)} src={preview.url} />
        : <div className="flex size-full items-center justify-center text-muted-foreground">
          {!failed && (state === "processing" || state === "uploading") ? <LoaderCircleIcon className="size-5 animate-spin" /> : failed ? <RotateCcwIcon className="size-5" /> : <ImageIcon className="size-5" />}
        </div>}
      {failed ? <AttachmentTrigger aria-label={`${retryLabel}: ${name}`} onClick={retry} title={preview.error ?? retryLabel} />
        : preview.url ? <AttachmentTrigger aria-label={label} className="cursor-zoom-in" onClick={() => setOpen(true)} /> : null}
      {children}
    </Attachment>
    <Dialog open={open && Boolean(preview.url) && !failed} onOpenChange={setOpen}>
      <DialogContent aria-describedby={undefined} className="w-fit max-w-[calc(100vw-2rem)] overflow-hidden border-0 bg-background p-0 shadow-2xl sm:max-w-[calc(100vw-3rem)]" showCloseButton={false}>
        <DialogTitle className="sr-only">{name}</DialogTitle>
        <img alt={name} className="block max-h-[85vh] max-w-full object-contain" src={preview.url} />
        <DialogClose aria-label={dismissLabel} className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full border bg-background/90 text-foreground shadow-sm focus-visible:ring-2 focus-visible:ring-ring"><XIcon className="size-4" /></DialogClose>
      </DialogContent>
    </Dialog>
  </>;
}
