"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { memo, useCallback, useEffect, useMemo, useRef, useState, createContext, useContext, } from "react";
import { cva } from "class-variance-authority";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useAui } from "@assistant-ui/react";
import { cn } from "../utils.js";
import { Popover, PopoverContent, PopoverTrigger, } from "../ui/popover.js";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, } from "../ui/command.js";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
export const DEFAULT_EFFORT_OPTIONS = [
    { id: "low", name: "Low" },
    { id: "medium", name: "Med" },
    { id: "high", name: "High" },
];
function getModelEfforts(model) {
    if (!model?.efforts)
        return undefined;
    return model.efforts === true ? DEFAULT_EFFORT_OPTIONS : model.efforts;
}
function resolveEffort(efforts, effort) {
    if (effort === undefined)
        return undefined;
    return efforts?.some((e) => e.id === effort) ? effort : undefined;
}
export function resolveModelEffort(models, modelId, effort) {
    return resolveEffort(getModelEfforts(models.find((m) => m.id === modelId)), effort);
}
function useControllableState({ prop, defaultProp, onChange, }) {
    const [internal, setInternal] = useState(defaultProp);
    const isControlled = prop !== undefined;
    const value = isControlled ? prop : internal;
    const onChangeRef = useRef(onChange);
    useEffect(() => {
        onChangeRef.current = onChange;
    });
    const setValue = useCallback((next) => {
        if (!isControlled)
            setInternal(next);
        onChangeRef.current?.(next);
    }, [isControlled]);
    return [value, setValue];
}
const ModelSelectorContext = createContext(null);
function useModelSelectorContext() {
    const ctx = useContext(ModelSelectorContext);
    if (!ctx) {
        throw new Error("ModelSelector sub-components must be used within ModelSelector.Root");
    }
    return ctx;
}
export function useModelSelectorEfforts() {
    const { efforts, effort, setEffort } = useModelSelectorContext();
    return { efforts, effort, setEffort };
}
function ModelSelectorRoot({ models, value: valueProp, defaultValue, onValueChange, effort: effortProp, defaultEffort, onEffortChange, open: openProp, defaultOpen, onOpenChange, children, }) {
    const [value, setValue] = useControllableState({
        prop: valueProp,
        defaultProp: defaultValue ?? models[0]?.id,
        onChange: onValueChange,
    });
    const [effort, setEffort] = useControllableState({
        prop: effortProp,
        defaultProp: defaultEffort,
        onChange: onEffortChange,
    });
    const [open, setOpen] = useControllableState({
        prop: openProp,
        defaultProp: defaultOpen ?? false,
        onChange: onOpenChange,
    });
    const selectedModel = models.find((m) => m.id === value);
    const efforts = getModelEfforts(selectedModel);
    const activeEffort = resolveEffort(efforts, effort);
    const contextValue = useMemo(() => ({
        models,
        value,
        setValue,
        selectedModel,
        efforts,
        effort: activeEffort,
        setEffort,
        setOpen,
    }), [
        models,
        value,
        setValue,
        selectedModel,
        efforts,
        activeEffort,
        setEffort,
        setOpen,
    ]);
    return (_jsx(ModelSelectorContext.Provider, { value: contextValue, children: _jsx(Popover, { open: open ?? false, onOpenChange: setOpen, children: children }) }));
}
export const modelSelectorTriggerVariants = cva("focus-visible:ring-ring/50 flex w-fit items-center justify-between gap-2 overflow-hidden rounded-md text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5", {
    variants: {
        variant: {
            outline: "border-input hover:bg-accent hover:text-accent-foreground border bg-transparent",
            ghost: "hover:bg-accent hover:text-accent-foreground",
            muted: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        },
        size: {
            default: "h-9 px-3 py-2",
            sm: "h-8 px-2.5 py-1.5 text-xs",
            lg: "h-10 px-4 py-2.5",
        },
    },
    defaultVariants: {
        variant: "outline",
        size: "default",
    },
});
function ModelSelectorTrigger({ className, variant, size, children, onKeyDown, ...props }) {
    const { setOpen } = useModelSelectorContext();
    return (_jsxs(PopoverTrigger, { "data-slot": "model-selector-trigger", "data-variant": variant ?? "outline", "data-size": size ?? "default", role: "combobox", "aria-haspopup": "listbox", className: cn(modelSelectorTriggerVariants({ variant, size }), className), onKeyDown: (e) => {
            onKeyDown?.(e);
            if (e.defaultPrevented)
                return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setOpen(true);
            }
        }, ...props, children: [children ?? _jsx(ModelSelectorValue, {}), _jsx(ChevronDownIcon, { className: "size-4 opacity-50" })] }));
}
function ModelIcon({ children, className, }) {
    return (_jsx("span", { className: cn("flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5", className), children: children }));
}
function ModelSelectorValue({ placeholder = "Select model", showEffort = true, className, }) {
    const { selectedModel, efforts, effort } = useModelSelectorContext();
    if (!selectedModel) {
        return (_jsx("span", { "data-slot": "model-selector-value", className: cn("text-muted-foreground", className), children: placeholder }));
    }
    const effortName = showEffort && effort !== undefined
        ? efforts?.find((e) => e.id === effort)?.name
        : undefined;
    return (_jsxs("span", { "data-slot": "model-selector-value", className: cn("flex min-w-0 items-center gap-1", className), children: [selectedModel.icon && _jsx(ModelIcon, { children: selectedModel.icon }), _jsx("span", { className: "truncate text-xs font-normal", children: selectedModel.name }), effortName && (_jsx("span", { className: "text-muted-foreground truncate text-xs", children: effortName }))] }));
}
function useLazyFlipSide() {
    const [side, setSide] = useState();
    const observerRef = useRef(null);
    const popupRef = useCallback((node) => {
        observerRef.current?.disconnect();
        observerRef.current = null;
        if (!node) {
            setSide(undefined);
            return;
        }
        const sync = () => {
            const rendered = node.getAttribute("data-side");
            if (rendered)
                setSide(rendered);
        };
        sync();
        const observer = new MutationObserver(sync);
        observer.observe(node, {
            attributes: true,
            attributeFilter: ["data-side"],
        });
        observerRef.current = observer;
    }, []);
    return { side, popupRef };
}
function ModelSelectorFocusAnchor() {
    return (_jsx("div", { className: "sr-only", children: _jsx(CommandInput, { readOnly: true, "aria-label": "Model" }) }));
}
function ModelSelectorContent({ className, align = "start", effortLabel, side, sideOffset = 6, searchable, children, ...props }) {
    const { value } = useModelSelectorContext();
    const { side: renderedSide, popupRef } = useLazyFlipSide();
    const unfiltered = searchable === false || (!searchable && children === undefined);
    return (_jsx(PopoverContent, { ref: popupRef, "data-slot": "model-selector-content", align: align, side: renderedSide ?? side ?? "bottom", sideOffset: sideOffset, className: cn("bg-popover/95 w-72 min-w-(--radix-popover-trigger-width) overflow-hidden rounded-xl p-0 text-xs shadow-lg backdrop-blur-sm", className), ...props, children: _jsxs(Command, { className: "bg-transparent", shouldFilter: !unfiltered, ...(value !== undefined ? { defaultValue: value } : {}), children: [unfiltered && _jsx(ModelSelectorFocusAnchor, {}), children ?? (_jsxs(_Fragment, { children: [searchable && _jsx(ModelSelectorSearch, {}), _jsx(ModelSelectorList, {}), _jsx(ModelSelectorEffort, { label: effortLabel })] }))] }) }));
}
function ModelSelectorSearch({ placeholder = "Search models...", ...props }) {
    return (_jsx(CommandInput, { "data-slot": "model-selector-search", placeholder: placeholder, ...props }));
}
function ModelSelectorList({ className, children, ...props }) {
    const { models } = useModelSelectorContext();
    return (_jsx(CommandList, { "data-slot": "model-selector-list", className: cn("[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className), ...props, children: children ?? (_jsxs(_Fragment, { children: [_jsx(ModelSelectorEmpty, {}), _jsx(CommandGroup, { children: models.map((model) => (_jsx(ModelSelectorItem, { model: model }, model.id))) })] })) }));
}
function ModelSelectorEmpty({ children, ...props }) {
    return (_jsx(CommandEmpty, { "data-slot": "model-selector-empty", ...props, children: children ?? "No models found." }));
}
function ModelSelectorGroup(props) {
    return _jsx(CommandGroup, { "data-slot": "model-selector-group", ...props });
}
function ModelSelectorSeparator(props) {
    return _jsx(CommandSeparator, { "data-slot": "model-selector-separator", ...props });
}
function ModelSelectorItem({ model, className, children, onSelect, ...props }) {
    const { value, setValue, setOpen } = useModelSelectorContext();
    const isSelected = value === model.id;
    return (_jsxs(CommandItem, { "data-slot": "model-selector-item", value: model.id, keywords: [model.name, ...(model.keywords ?? [])], ...(model.disabled ? { disabled: true } : undefined), onSelect: (selectedValue) => {
            setValue(model.id);
            setOpen(false);
            onSelect?.(selectedValue);
        }, className: cn("relative items-start gap-2 rounded-lg py-2 ps-3 pe-9 [&_svg:not([class*='size-'])]:size-3.5", className), ...props, children: [children ?? (_jsxs(_Fragment, { children: [model.icon && (_jsx(ModelIcon, { className: "mt-[3px]", children: model.icon })), _jsxs("span", { className: "flex min-w-0 flex-col", children: [_jsx("span", { className: "truncate text-xs leading-5 font-medium", "data-slot": "model-selector-item-name", children: model.name }), model.description && (_jsx("span", { className: "text-muted-foreground truncate text-xs", children: model.description }))] })] })), isSelected && (_jsx("span", { className: "absolute end-3 top-2.5 flex size-4 items-center justify-center", children: _jsx(CheckIcon, { className: "size-4" }) }))] }));
}
function ModelSelectorEffort({ label = "Thinking", className, onKeyDown, ...props }) {
    const { efforts, effort, setEffort } = useModelSelectorEfforts();
    if (!efforts?.length)
        return null;
    return (_jsxs("div", { "data-slot": "model-selector-effort", className: cn("flex cursor-default flex-col items-stretch gap-1 border-t px-2.5 py-1.5", className), onKeyDown: (e) => {
            onKeyDown?.(e);
            if (e.defaultPrevented)
                return;
            if (e.key === "Home" || e.key === "End")
                e.stopPropagation();
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.currentTarget
                    .closest("[cmdk-root]")
                    ?.querySelector("[cmdk-input]")
                    ?.focus();
            }
        }, ...props, children: [_jsx("span", { className: "text-muted-foreground text-[10px] leading-3.5", children: label }), _jsx(RadioGroupPrimitive.Root, { value: effort ?? "", onValueChange: setEffort, orientation: "horizontal", "aria-label": typeof label === "string" ? label : "Reasoning effort", className: "grid w-full grid-cols-4 gap-0.5", children: efforts.map((option) => (_jsx(RadioGroupPrimitive.Item, { value: option.id, className: cn("focus-visible:ring-ring/50 text-muted-foreground hover:text-foreground min-w-0 truncate rounded-md px-1 py-0.5 text-center text-xs leading-5 font-medium transition-colors outline-none focus-visible:ring-2", "data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground data-[state=checked]:font-medium"), children: option.name }, option.id))) })] }));
}
function ModelSelectorModelContext() {
    const { value, effort } = useModelSelectorContext();
    const api = useAui();
    useEffect(() => {
        if (value === undefined)
            return;
        const config = {
            config: {
                modelName: value,
                ...(effort !== undefined ? { reasoningEffort: effort } : undefined),
            },
        };
        return api.modelContext.register({
            getModelContext: () => config,
        });
    }, [api, value, effort]);
    return null;
}
const ModelSelectorImpl = ({ searchable, variant, size, align, className, contentClassName, effortLabel, triggerLabel, valueClassName, ...rootProps }) => {
    return (_jsxs(ModelSelectorRoot, { ...rootProps, children: [_jsx(ModelSelectorModelContext, {}), _jsx(ModelSelectorTrigger, { "aria-label": triggerLabel, variant: variant, size: size, className: className, children: _jsx(ModelSelectorValue, { className: valueClassName }) }), _jsx(ModelSelectorContent, { ...(align !== undefined ? { align } : {}), className: contentClassName, effortLabel: effortLabel, searchable: searchable ?? false })] }));
};
const ModelSelector = memo(ModelSelectorImpl);
ModelSelector.displayName = "ModelSelector";
ModelSelector.Root = ModelSelectorRoot;
ModelSelector.Trigger = ModelSelectorTrigger;
ModelSelector.Value = ModelSelectorValue;
ModelSelector.Content = ModelSelectorContent;
ModelSelector.Search = ModelSelectorSearch;
ModelSelector.FocusAnchor = ModelSelectorFocusAnchor;
ModelSelector.List = ModelSelectorList;
ModelSelector.Empty = ModelSelectorEmpty;
ModelSelector.Group = ModelSelectorGroup;
ModelSelector.Separator = ModelSelectorSeparator;
ModelSelector.Item = ModelSelectorItem;
ModelSelector.Effort = ModelSelectorEffort;
export { ModelSelector, ModelSelectorRoot, ModelSelectorTrigger, ModelSelectorValue, ModelSelectorContent, ModelSelectorSearch, ModelSelectorFocusAnchor, ModelSelectorList, ModelSelectorEmpty, ModelSelectorGroup, ModelSelectorSeparator, ModelSelectorItem, ModelSelectorEffort, };
//# sourceMappingURL=model-selector.js.map