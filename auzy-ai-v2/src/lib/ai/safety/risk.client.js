// Client for the auzy-risk service (Python: crisis phrases in 4 languages + the multilingual risk model).
// Never throws: if the service is slow or down, it reports `unavailable` and the turn service answers that
// message with the careful model instead.

export function createRiskClient({ url, timeoutMs = 1500, fetchImpl = globalThis.fetch, log = console } = {}) {
    return {
        /** -> { phrase: {category, language, match} | null, model: {risk, riskScore, state} | null, unavailable: bool } */
        async assess(text) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            try {
                const res = await fetchImpl(`${url}/assess`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text }),
                    signal: ctrl.signal,
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const body = await res.json();
                return {
                    phrase: body.phrase || null,
                    model: body.model ? { risk: !!body.model.risk, riskScore: Number(body.model.risk_score) || 0, state: body.model.state || 'unknown' } : null,
                    unavailable: false,
                };
            } catch (e) {
                log.warn?.(`[ai] risk service unavailable: ${e?.message || e}`);
                return { phrase: null, model: null, unavailable: true };
            } finally {
                clearTimeout(timer);
            }
        },
    };
}
