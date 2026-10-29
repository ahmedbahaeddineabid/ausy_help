// Token usage -> cost, for the AiUsage ledger.

export function usageOf(response) {
    const u = response?.usage || {};
    return {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
    };
}

export function costOf(model, usage, prices) {
    const p = prices[model];
    if (!p) return 0;
    return (usage.input * p.input + usage.output * p.output
        + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / 1e6;
}

/**
 * One ledger row per Claude call. kind: chat | second_opinion | urgent_summary | end_analysis
 * session: the conversation's session number, so the budget governor can total the cost of each finished conversation.
 */
export function usageRecord({ kind, model, response, prices, refused = false, conversationId, profileId, session = null }) {
    const usage = usageOf(response);
    return { kind, model, ...usage, costUsd: costOf(model, usage, prices), refused, conversationId, profileId, session };
}
