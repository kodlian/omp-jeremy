export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A tool result holding one text. */
export const toolReply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });
