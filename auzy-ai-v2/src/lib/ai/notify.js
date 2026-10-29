// POSTs alerts (escalations) and clinician summaries to an internal webhook (Slack, Teams or your own endpoint).
// The payload contains health information: point it only at an internal channel the care team controls.
// Never throws: a failed notification must not break the chat.

export function createWebhookNotifier({ url, fetchImpl = globalThis.fetch, log = console, timeoutMs = 5000 } = {}) {
    return async function notify(payload) {
        if (!url) return false;
        const title = payload.type === 'escalation'
            ? `[ESCALATION] conversation ${payload.conversationId}: ${payload.reason}`
            : `${payload.urgent ? '[URGENT] ' : ''}Clinician summary, conversation ${payload.conversationId} (${payload.trigger})`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: title, ...payload }),
                signal: ctrl.signal,
            });
            return res.ok;
        } catch (e) {
            log.warn?.(`[ai] webhook failed: ${e?.message || e}`);
            return false;
        } finally {
            clearTimeout(timer);
        }
    };
}
