"use client";

import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { useAuiEvent } from "@assistant-ui/react";

/** One scroll owner for chat following and a single task anchor per submission. */
export function useTaskScrollAnchor({
  hasExecutionGroup,
  isBusy,
  isEditing,
  isRestoring,
  renderedUserId,
  scrollOnInitialize,
  scrollOnThreadSwitch,
  userId,
  userKey,
  viewportRef,
}: {
  readonly hasExecutionGroup: boolean;
  readonly isBusy: boolean;
  readonly isEditing: boolean;
  readonly isRestoring: boolean;
  readonly renderedUserId?: string;
  readonly scrollOnInitialize: boolean;
  readonly scrollOnThreadSwitch: boolean;
  readonly userId?: string;
  readonly userKey?: string;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const reserveRef = useRef<HTMLDivElement>(null);
  const [anchoredKey, setAnchoredKey] = useState<string>();
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
    if (reserveRef.current) reserveRef.current.style.height = "0px";
    const viewport = viewportRef.current;
    if (viewport && scrollOnThreadSwitch) viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
  });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // Only gestures opt out. Content growth, pagination restoration and our
    // own smooth scroll also emit scroll events and must not count as gestures.
    const optOut = () => { segment.current.eligible = false; following.current = false; };
    let lastTop = viewport.scrollTop;
    let lastHeight = viewport.scrollHeight;
    const onScroll = () => {
      if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1 && !segment.current.anchored) following.current = true;
      else if (viewport.scrollTop < lastTop && viewport.scrollHeight === lastHeight) optOut();
      lastTop = viewport.scrollTop;
      lastHeight = viewport.scrollHeight;
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.target === viewport) optOut(); // scrollbar / viewport background
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]')) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) optOut();
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
    // External-store props can arrive before assistant-ui commits its message
    // rows. Keep the initial scroll pending until both refer to the same user.
    if (!viewport) return;
    if (!userKey) {
      if (!isRestoring) initialized.current = true;
      return;
    }
    if (renderedUserId !== userId) return;
    const initializing = !initialized.current;
    const changed = segment.current.key !== userKey;
    if (changed) {
      segment.current = { key: userKey, eligible: !initializing && !isRestoring && isBusy, anchored: false };
      if (isBusy && !isRestoring && !initializing) following.current = true;
      setAnchoredKey(undefined);
      if (reserveRef.current) reserveRef.current.style.height = "0px";
    }
    const shouldShowLatest = (!initialized.current && scrollOnInitialize && following.current)
      || (changed && isBusy && !isRestoring && !initializing);
    if (!isRestoring) initialized.current = true;
    if (hasExecutionGroup && segment.current.eligible && !segment.current.anchored) {
      segment.current.anchored = true;
      following.current = false;
      setAnchoredKey(userKey);
    } else if (shouldShowLatest) {
      // No native pending scroll intent: it would survive the later handoff
      // to task anchoring and pull the viewport down again during streaming.
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
    }
  }, [hasExecutionGroup, isBusy, isRestoring, renderedUserId, scrollOnInitialize, userId, userKey, viewportRef]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const footer = viewport?.querySelector<HTMLElement>('[data-slot="thread-viewport-footer"]');
    if (!viewport || !content || !footer) return;
    // Keep intent across fast content growth before a browser scroll event.
    // A gesture clears it; reaching bottom or sending a new message resumes it.
    const observer = new ResizeObserver(() => {
      if (following.current && !isEditing) viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
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
    if (!isAnchored || !viewport || !content || !reserve) return;
    const anchor = [...content.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((element) => element.dataset.messageId === userId);
    const footer = viewport.querySelector<HTMLElement>('[data-slot="thread-viewport-footer"]');
    if (!anchor || !footer) return;
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
      if (reserve.offsetHeight !== height) reserve.style.height = `${height}px`;
    };
    updateReserve();
    const frame = requestAnimationFrame(() => {
      if (segment.current.eligible) viewport.scrollTo({ top: targetTop(), behavior: "smooth" });
    });
    // Retain enough space through final output / execution-group collapse,
    // without scrolling again when their heights change.
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
