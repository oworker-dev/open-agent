"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { authenticatedAssetPreviewUrl, prepareBrowserAssetDownload, readBrowserAssetPreview, readBrowserAssetText } from "./browser-asset-preview.js";
const AssetPreviewContext = createContext(undefined);
export function AssetPreviewProvider({ client, children }) {
    return _jsx(AssetPreviewContext.Provider, { value: client, children: children });
}
export function useAssetPreview(source) {
    const config = useContext(AssetPreviewContext);
    const [attempt, setAttempt] = useState(0);
    const [result, setResult] = useState();
    const protectedUrl = source && typeof window !== "undefined" && (config?.headers || config?.auth)
        ? authenticatedAssetPreviewUrl(source, config.host || window.location.origin) : undefined;
    useEffect(() => {
        if (!protectedUrl)
            return;
        const controller = new AbortController();
        let objectUrl;
        void readBrowserAssetPreview(protectedUrl, config, controller.signal).then(blob => {
            if (controller.signal.aborted)
                return;
            objectUrl = URL.createObjectURL(blob);
            setResult({ source: protectedUrl, url: objectUrl });
        }).catch((error) => {
            if (!controller.signal.aborted)
                setResult({ source: protectedUrl, error: error instanceof Error ? error.message : "Image preview failed." });
        });
        return () => {
            controller.abort();
            if (objectUrl)
                URL.revokeObjectURL(objectUrl);
        };
    }, [protectedUrl, config, attempt]);
    return {
        url: protectedUrl ? result?.source === protectedUrl ? result.url : undefined : source,
        error: protectedUrl && result?.source === protectedUrl ? result.error : undefined,
        retry: () => { setResult(undefined); setAttempt(value => value + 1); },
    };
}
export function useAssetText(source) {
    const config = useContext(AssetPreviewContext);
    const [attempt, setAttempt] = useState(0);
    const [result, setResult] = useState();
    useEffect(() => {
        if (!source)
            return;
        const controller = new AbortController();
        void readBrowserAssetText(source, config, controller.signal).then(value => {
            if (!controller.signal.aborted)
                setResult({ source, ...value });
        }).catch((error) => {
            if (!controller.signal.aborted)
                setResult({ source, error: error instanceof Error ? error.message : "File preview failed." });
        });
        return () => controller.abort();
    }, [source, config, attempt]);
    return {
        ...(source && result?.source === source ? result : {}),
        retry: () => { setResult(undefined); setAttempt(value => value + 1); },
    };
}
export function useAssetDownload(source, filename) {
    const config = useContext(AssetPreviewContext);
    const active = useRef(undefined);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState();
    useEffect(() => {
        setError(undefined);
        setLoading(false);
        return () => { active.current?.abort(); active.current = undefined; };
    }, [source, config]);
    const download = async () => {
        if (!source || active.current)
            return;
        const controller = new AbortController();
        active.current = controller;
        setLoading(true);
        setError(undefined);
        try {
            const url = await prepareBrowserAssetDownload(source, config, controller.signal);
            controller.signal.throwIfAborted();
            const link = document.createElement("a");
            link.href = url;
            link.download = filename;
            link.rel = "noreferrer";
            link.referrerPolicy = "no-referrer";
            document.body.append(link);
            link.click();
            link.remove();
        }
        catch (reason) {
            if (!controller.signal.aborted)
                setError(reason instanceof Error ? reason.message : "File download failed.");
        }
        finally {
            if (active.current === controller) {
                active.current = undefined;
                setLoading(false);
            }
        }
    };
    return { download, loading, error };
}
//# sourceMappingURL=asset-preview.js.map