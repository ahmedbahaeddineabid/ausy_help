// Reads and writes Cognisys through auzy-backend's existing services/cognisys.service.js, so the stored
// data model (CognisysProfile, Fact, Dimension, Analysis) and every screen that reads it stay unchanged.

export function createCognisysAdapter(svc) {
    return {
        async getSnapshot(profileId) {
            await svc.ensureCognisysProfile(profileId, { summary: 'Pending summary' });
            const [profile, facts, dimensions, analyses] = await Promise.all([
                svc.getCognisysProfileByProfileId(profileId),
                svc.getFacts(profileId, { order: 'desc', limit: 50 }),
                svc.getDimensions(profileId, { order: 'desc' }),
                svc.getAnalyses(profileId, { order: 'desc', limit: 3 }),
            ]);
            return { profile, facts, dimensions, analyses };
        },

        /** Applies the `cognisys` part of the end-of-conversation analysis. */
        async apply(profileId, out) {
            if (!out) return { facts: 0, dimensions: 0 };
            const aggregate = await svc.ensureCognisysProfile(profileId, { summary: 'Pending summary' });
            const version = (Number(aggregate?.currentVersion) || 0) + 1;
            let facts = 0;
            for (const f of out.facts || []) {
                await svc.saveFact(profileId, {
                    category: String(f.category || '').trim().toLowerCase(),
                    key: String(f.key || '').trim(),
                    value: f.value,
                    valueType: f.valueType,
                    unit: f.unit || undefined,
                    confidence: f.confidence,
                    source: f.source,
                });
                facts += 1;
            }
            let dimensions = 0;
            for (const d of out.dimensions || []) {
                await svc.saveDimension(profileId, {
                    dimension: String(d.dimension || '').trim().toLowerCase(),
                    score: Number(d.score) || 0,
                    factors: Array.isArray(d.factors) ? d.factors.slice(0, 5) : [],
                });
                dimensions += 1;
            }
            if (out.analysisAppend?.summary) {
                await svc.saveAnalysis(profileId, { analysisType: out.analysisAppend.analysisType, summary: out.analysisAppend.summary, profileVersion: version });
            }
            const p = out.profile || {};
            const set = { currentVersion: version, totalAnalysisRuns: (Number(aggregate?.totalAnalysisRuns) || 0) + 1, lastAnalysisDate: new Date() };
            if (typeof p.summary === 'string' && p.summary.trim()) set.summary = p.summary.trim();
            for (const k of ['tags', 'keyInsights', 'riskFactors', 'opportunities']) {
                if (Array.isArray(p[k])) set[k] = [...new Set(p[k].map((x) => String(x).trim()).filter(Boolean))];
            }
            if (aggregate?._id) await svc.updateCognisysProfileById(aggregate._id, set);
            return { facts, dimensions };
        },
    };
}
