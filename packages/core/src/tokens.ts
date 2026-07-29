/**
 * Cheap token estimate. We deliberately do not pull in a real tokenizer: this
 * runs inside a hook with a sub-second budget, and the number is only used to
 * decide how many items fit in a brief. Over-estimating slightly is the safe
 * direction, so the divisor is conservative.
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    // ~3.6 chars/token for prose-with-code, plus a per-line overhead for markdown.
    const lines = text.split('\n').length;
    return Math.ceil(text.length / 3.6) + lines;
}

export function truncateToTokens(text: string, maxTokens: number): string {
    if (estimateTokens(text) <= maxTokens) return text;
    const maxChars = Math.max(16, Math.floor(maxTokens * 3.6));
    return text.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
}
