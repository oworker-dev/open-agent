export type MultiSelectAnswer = {
    readonly optionIds: readonly string[];
    readonly additionalText: string;
};
export declare function encodeMultiSelectAnswer(answer: MultiSelectAnswer): string;
export declare function parseMultiSelectAnswer(value: string): MultiSelectAnswer | undefined;
//# sourceMappingURL=ask-question-answer.d.ts.map