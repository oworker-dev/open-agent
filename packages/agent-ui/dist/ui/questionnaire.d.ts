import * as React from "react";
import { Questionnaire as QuestionnairePrimitive } from "@shadcn/react/questionnaire";
import { type Button } from "./button.js";
declare function Questionnaire({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Root>): import("react/jsx-runtime").JSX.Element;
declare function QuestionnaireItem({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Item>): import("react/jsx-runtime").JSX.Element;
declare function QuestionnaireTitle({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Title>): import("react/jsx-runtime").JSX.Element;
declare function QuestionnaireDescription({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Description>): import("react/jsx-runtime").JSX.Element;
declare function QuestionnaireChoices({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Choices>): import("react/jsx-runtime").JSX.Element;
declare function QuestionnaireChoice({ children, className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Choice>): import("react/jsx-runtime").JSX.Element;
declare function QuestionnaireChoiceDescription({ className, ...props }: React.ComponentProps<"span">): import("react/jsx-runtime").JSX.Element;
declare function QuestionnaireSubmit({ children, className, size, variant, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Submit> & Pick<React.ComponentProps<typeof Button>, "size" | "variant">): import("react/jsx-runtime").JSX.Element;
declare function QuestionnaireError({ className, ...props }: React.ComponentProps<typeof QuestionnairePrimitive.Error>): import("react/jsx-runtime").JSX.Element;
export { Questionnaire, QuestionnaireChoice, QuestionnaireChoiceDescription, QuestionnaireChoices, QuestionnaireDescription, QuestionnaireError, QuestionnaireItem, QuestionnaireSubmit, QuestionnaireTitle, };
//# sourceMappingURL=questionnaire.d.ts.map