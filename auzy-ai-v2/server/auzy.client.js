// Calls auzy-backend's callback endpoints (integration/auzy-backend/src/routes/ai-tools.route.js and
// ai-webhook.route.js). The API never touches Auzy's database: tools, the Cognisys snapshot and the delivery of
// each analysis all go through these endpoints, with the shared secret AUZY_CALLBACK_SECRET.

export function createAuzyClient({ baseUrl, secret, fetchImpl = globalThis.fetch, timeoutMs = 5000 }) {
    async function call(method, path, body, timeout = timeoutMs) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        try {
            const res = await fetchImpl(`${baseUrl}${path}`, {
                method,
                headers: { Authorization: `Bearer ${secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined,
                signal: ctrl.signal,
            });
            if (res.status === 404 && method === 'GET') return null;
            if (!res.ok) throw new Error(`auzy-backend ${method} ${path}: HTTP ${res.status}`);
            return res.status === 204 ? null : await res.json();
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        mode: 'callback',
        // Same interface as auzy-backend's services, as src/lib/ai/tools/index.js#createToolbox expects.
        services: {
            findProfiles: (query, opts) => call('POST', '/tools/find-consultants', { search: query?.search || '', limit: opts?.limit }),
            async listAppointmentsForProfile(profileId, role, opts) {
                const out = await call('POST', '/tools/appointments', { profileId, when: opts?.when, limit: opts?.limit });
                return out?.appointments || [];
            },
            publicListAgents: (q) => call('POST', '/tools/tests', { search: q?.search || '', limit: q?.limit }),
        },
        cognisys: {
            // An error here fails the analysis (retried later): analysing without the stored profile would overwrite it.
            getSnapshot: (profileId) => call('GET', `/cognisys/${encodeURIComponent(profileId)}`),
            // The update is not written here: it travels to auzy-backend with the rest of the analysis (deliverAnalysis).
            async apply(profileId, out) {
                return { facts: out?.facts?.length || 0, dimensions: out?.dimensions?.length || 0 };
            },
        },
        deliverAnalysis: (payload) => call('POST', '/analysis', payload, Math.max(timeoutMs, 15000)),
    };
}
