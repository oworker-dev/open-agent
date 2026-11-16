"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { useAuiEvent } from "@assistant-ui/react";
export function useTaskScrollAnchor({ hasExecutionGroup, isBusy, isEditing, isRestoring, renderedUserId, scrollOnInitialize, scrollOnThreadSwitch, userId, userKey, viewportRef, }) {
    const contentRef = useRef(null);
    const reserveRef = useRef(null);
    const [anchoredKey, setAnchoredKey] = useState();
    const segment = useRef({ key: userKey, eligible: false, anchored: false });
    const following = useRef(scrollOnInitialize);
    const initialized = useRef(false);
    const isAnchored = !!userKey && anchoredKey === userKey;
    const resumeBottomFollow = () => {
        segment.current.eligible = false;
        following.current = true;
        setAnchoredKey(undefined);
    };
    useAuiEvent("threadListItem.switchedTo", () => {
        segment.current = { key: userKey, eligible: false, anchored: false };
        following.current = scrollOnThreadSwitch;
        setAnchoredKey(undefined);
        if (reserveRef.current)
            reserveRef.current.style.height = "0px";
        const viewport = viewportRef.current;
        if (viewport && scrollOnThreadSwitch)
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
    });
    useLayoutEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport)
            return;
        const optOut = () => { segment.current.eligible = false; following.current = false; };
        let lastTop = viewport.scrollTop;
        let lastHeight = viewport.scrollHeight;
        const onScroll = () => {
            if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1 && !segment.current.anchored)
                following.current = true;
            else if (viewport.scrollTop < lastTop && viewport.scrollHeight === lastHeight)
                optOut();
            lastTop = viewport.scrollTop;
            lastHeight = viewport.scrollHeight;
        };
        const pointerDown = (event) => {
            if (event.target === viewport)
                optOut();
        };
        const keyDown = (event) => {
            if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]'))
                return;
            if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
                optOut();
        };
        viewport.addEventListener("wheel", optOut, { passive: true });
        viewport.addEventListener("touchmove", optOut, { passive: true });
        viewport.addEventListener("pointerdown", pointerDown);
        viewport.addEventListener("keydown", keyDown);
        viewport.addEventListener("scroll", onScroll);
        return () => {
            viewport.removeEventListener("wheel", optOut);
            viewport.removeEventListener("touchmove", optOut);
            viewport.removeEventListener("pointerdown", pointerDown);
            viewport.removeEventListener("keydown", keyDown);
            viewport.removeEventListener("scroll", onScroll);
        };
    }, [viewportRef]);
    useLayoutEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport)
            return;
        if (!userKey) {
            if (!isRestoring)
                initialized.current = true;
            return;
        }
        if (renderedUserId !== userId)
            return;
        const initializing = !initialized.current;
        const changed = segment.current.key !== userKey;
        if (changed) {
            segment.current = { key: userKey, eligible: !initializing && !isRestoring && isBusy, anchored: false };
            if (isBusy && !isRestoring && !initializing)
                following.current = true;
            setAnchoredKey(undefined);
            if (reserveRef.current)
                reserveRef.current.style.height = "0px";
        }
        const shouldShowLatest = (!initialized.current && scrollOnInitialize && following.current)
            || (changed && isBusy && !isRestoring && !initializing);
        if (!isRestoring)
            initialized.current = true;
        if (hasExecutionGroup && segment.current.eligible && !segment.current.anchored) {
            segment.current.anchored = true;
            following.current = false;
            setAnchoredKey(userKey);
        }
        else if (shouldShowLatest) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
        }
    }, [hasExecutionGroup, isBusy, isRestoring, renderedUserId, scrollOnInitialize, userId, userKey, viewportRef]);
    useLayoutEffect(() => {
        const viewport = viewportRef.current;
        const content = contentRef.current;
        const footer = viewport?.querySelector('[data-slot="thread-viewport-footer"]');
        if (!viewport || !content || !footer)
            return;
        const observer = new ResizeObserver(() => {
            if (following.current && !isEditing)
                viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
        });
        observer.observe(viewport);
        observer.observe(content);
        observer.observe(footer);
        return () => observer.disconnect();
    }, [isEditing, viewportRef]);
    useLayoutEffect(() => {
        const viewport = viewportRef.current;
        const content = contentRef.current;
        const reserve = reserveRef.current;
        if (!isAnchored || !viewport || !content || !reserve)
            return;
        const anchor = [...content.querySelectorAll("[data-message-id]")]
            .find((element) => element.dataset.messageId === userId);
        const footer = viewport.querySelector('[data-slot="thread-viewport-footer"]');
        if (!anchor || !footer)
            return;
        const targetTop = () => {
            const height = anchor.offsetHeight;
            const em = Number.parseFloat(getComputedStyle(anchor).fontSize);
            return anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
                + (height > 10 * em ? height - 6 * em : 0);
        };
        const updateReserve = () => {
            const naturalBottom = content.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top
                + viewport.scrollTop + Number.parseFloat(getComputedStyle(content).marginBottom) + footer.offsetHeight;
            const height = Math.max(0, Math.ceil(targetTop() + viewport.clientHeight - naturalBottom));
            if (reserve.offsetHeight !== height)
                reserve.style.height = `${height}px`;
        };
        updateReserve();
        const frame = requestAnimationFrame(() => {
            if (segment.current.eligible)
                viewport.scrollTo({ top: targetTop(), behavior: "smooth" });
        });
        const observer = new ResizeObserver(updateReserve);
        observer.observe(viewport);
        observer.observe(content);
        observer.observe(footer);
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            reserve.style.height = "0px";
        };
    }, [isAnchored, userId, viewportRef]);
    return { contentRef, reserveRef, resumeBottomFollow };
}
//# sourceMappingURL=use-task-scroll-anchor.js.map