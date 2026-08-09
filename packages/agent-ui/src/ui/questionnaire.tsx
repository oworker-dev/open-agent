"use client";

import * as React from "react";
import { Questionnaire as QuestionnairePrimitive } from "@shadcn/react/questionnaire";
import { cn } from "../utils.js";
import { buttonVariants, type Button } from "./button.js";

function Questionnaire({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Root>) {
  return <QuestionnairePrimitive.Root data-slot="questionnaire" className={cn("flex w-full min-w-0 flex-col gap-3", className)} {...props} />;
}

function QuestionnaireItem({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Item>) {
  return <QuestionnairePrimitive.Item data-slot="questionnaire-item" className={cn("flex min-w-0 flex-col gap-3 border-0 p-0 outline-none", className)} {...props} />;
}

function QuestionnaireTitle({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Title>) {
  return <QuestionnairePrimitive.Title data-slot="questionnaire-title" className={cn("text-sm font-medium leading-5 text-foreground", className)} {...props} />;
}

function QuestionnaireDescription({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Description>) {
  return <QuestionnairePrimitive.Description data-slot="questionnaire-description" className={cn("text-xs leading-5 text-muted-foreground", className)} {...props} />;
}

function QuestionnaireChoices({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Choices>) {
  return <QuestionnairePrimitive.Choices data-slot="questionnaire-choices" className={cn("flex min-w-0 flex-col gap-1.5", className)} {...props} />;
}

function QuestionnaireChoice({ children, className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Choice>) {
  return (
    <QuestionnairePrimitive.Choice
      data-slot="questionnaire-choice"
      className={cn(
        "group/questionnaire-choice relative flex min-h-10 min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border border-border/70 bg-transparent px-3 py-2 text-left text-sm transition-colors outline-none select-none hover:bg-accent/60 has-[>input:focus-visible]:border-ring has-[>input:focus-visible]:ring-2 has-[>input:focus-visible]:ring-ring/30 data-checked:border-primary/30 data-checked:bg-accent/70 data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <QuestionnairePrimitive.ChoiceInput
        data-slot="questionnaire-choice-input"
        className="absolute inset-0 z-10 size-full cursor-pointer opacity-0"
      />
      <span aria-hidden="true" data-slot="questionnaire-choice-indicator" className="pointer-events-none mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-input group-data-checked/questionnaire-choice:border-primary group-data-checked/questionnaire-choice:bg-primary">
        <span className="hidden size-1.5 rounded-full bg-primary-foreground group-data-checked/questionnaire-choice:block" />
      </span>
      <QuestionnairePrimitive.ChoiceLabel data-slot="questionnaire-choice-label" className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
        {children}
      </QuestionnairePrimitive.ChoiceLabel>
    </QuestionnairePrimitive.Choice>
  );
}

function QuestionnaireChoiceDescription({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="questionnaire-choice-description" className={cn("break-words text-xs leading-5 text-muted-foreground", className)} {...props} />;
}

function QuestionnaireSubmit({ children, className, size = "sm", variant = "default", ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Submit> & Pick<React.ComponentProps<typeof Button>, "size" | "variant">) {
  return <QuestionnairePrimitive.Submit data-slot="questionnaire-submit" className={cn(buttonVariants({ size, variant }), "min-w-20", className)} {...props}>{children}</QuestionnairePrimitive.Submit>;
}

function QuestionnaireError({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Error>) {
  return <QuestionnairePrimitive.Error data-slot="questionnaire-error" className={cn("text-xs text-destructive", className)} {...props} />;
}

export {
  Questionnaire,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireItem,
  QuestionnaireSubmit,
  QuestionnaireTitle,
};
