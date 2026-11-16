import { type RefObject } from "react";
export declare function useTaskScrollAnchor({ hasExecutionGroup, isBusy, isEditing, isRestoring, renderedUserId, scrollOnInitialize, scrollOnThreadSwitch, userId, userKey, viewportRef, }: {
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
}): {
    contentRef: RefObject<HTMLDivElement | null>;
    reserveRef: RefObject<HTMLDivElement | null>;
    resumeBottomFollow: () => void;
};
//# sourceMappingURL=use-task-scroll-anchor.d.ts.map