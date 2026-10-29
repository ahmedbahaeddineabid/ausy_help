// MongoDB store (STORE=mongo): the engine's collections (src/model: AiSession, AiUsage, ClinicianSummary, through
// src/lib/ai/store.mongo.js) plus three collections of the API itself. Use a separate database on Auzy's MongoDB
// (MONGODB_DB, default auzy_ai): the API never reads or writes Auzy's own collections.

import mongoose from 'mongoose';
import { AiSession } from '../../src/model/AiSession.js';
import { AiUsage } from '../../src/model/AiUsage.js';
import { ClinicianSummary } from '../../src/model/ClinicianSummary.js';
import { mongoStore } from '../../src/lib/ai/store.mongo.js';
import { measureAverageCost } from '../../src/lib/ai/budget.mongo.js';

const { Mixed } = mongoose.Schema.Types;

// What auzy-backend sent with the latest message of a conversation: needed later by the idle analysis
// (pre-diagnostic due? which persona?).
const conversationSchema = new mongoose.Schema(
    {
        conversation: { type: String, required: true, unique: true },
        profile: String,
        creditsRemaining: Number,
        freeConsultationEligible: Boolean,
        persona: Mixed,                                  // name, domain, description: context for the analysis
    },
    { timestamps: true, minimize: false },
);

// Each end-of-conversation analysis and its delivery to auzy-backend (retried until delivered).
// delivery: pending | delivered | failed (gave up) | none (AUZY_MODE=demo)
const analysisSchema = new mongoose.Schema(
    {
        conversation: { type: String, required: true, index: true },
        profile: String,
        trigger: String,
        model: String,
        result: Mixed,                                   // { cognisys, clinicianSummary, diagnostic }
        delivery: { type: String, required: true },
        attempts: { type: Number, default: 0 },
        nextAttemptAt: Date,
        lastError: String,
        deliveredAt: Date,
    },
    { timestamps: true, minimize: false },
);
analysisSchema.index({ delivery: 1, nextAttemptAt: 1 });

const settingSchema = new mongoose.Schema({ key: { type: String, required: true, unique: true }, value: Mixed }, { timestamps: true });

const AiApiConversation = mongoose.model('AiApiConversation', conversationSchema);
const AiAnalysis = mongoose.model('AiAnalysis', analysisSchema);
const AiSetting = mongoose.model('AiSetting', settingSchema);

const str = (v) => (v == null ? null : String(v));

export const toSummary = (d) => ({
    id: str(d._id), conversationId: str(d.conversation), profileId: str(d.profile), trigger: d.trigger,
    model: d.model || null, urgent: Boolean(d.urgent), summary: d.summary, createdAt: d.createdAt,
});

export const toAnalysis = (d) => ({
    id: str(d._id), conversationId: d.conversation, profileId: d.profile || null, trigger: d.trigger, model: d.model || null,
    result: d.result, delivery: d.delivery, attempts: d.attempts || 0, nextAttemptAt: d.nextAttemptAt || null,
    lastError: d.lastError || null, deliveredAt: d.deliveredAt || null, createdAt: d.createdAt,
});

export const toConversationInfo = (d) => (d ? {
    profileId: d.profile || null, creditsRemaining: d.creditsRemaining ?? null,
    freeConsultationEligible: Boolean(d.freeConsultationEligible), persona: d.persona || null,
} : null);

export async function createMongoStore({ uri, dbName }) {
    await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10000 });
    await Promise.all([AiSession, AiUsage, ClinicianSummary, AiApiConversation, AiAnalysis, AiSetting].map((m) => m.init()));

    return {
        kind: 'mongo',
        async ping() {
            try {
                await mongoose.connection.db.command({ ping: 1 });
                return true;
            } catch {
                return false;
            }
        },
        close: () => mongoose.disconnect(),

        ...mongoStore,

        async saveConversationInfo(id, info) {
            await AiApiConversation.updateOne({ conversation: id }, {
                $set: { profile: info.profileId, creditsRemaining: info.creditsRemaining, freeConsultationEligible: info.freeConsultationEligible, persona: info.persona },
            }, { upsert: true });
        },
        async loadConversationInfo(id) {
            return toConversationInfo(await AiApiConversation.findOne({ conversation: id }).lean());
        },

        async dueForAnalysis(before, limit) {
            const docs = await AiSession.find({ needsAnalysis: true, lastTurnAt: { $lte: before } })
                .sort({ lastTurnAt: 1 }).limit(limit).select('conversation lastTurnAt').lean();
            return docs.map((d) => ({ conversationId: String(d.conversation), lastTurnAt: d.lastTurnAt.toISOString() }));
        },

        async saveAnalysis(rec) {
            const doc = await AiAnalysis.create({
                conversation: rec.conversationId, profile: rec.profileId, trigger: rec.trigger, model: rec.model, result: rec.result,
                delivery: rec.delivery, attempts: rec.attempts || 0, nextAttemptAt: rec.nextAttemptAt,
            });
            return String(doc._id);
        },
        async getAnalysis(id) {
            if (!mongoose.isValidObjectId(id)) return null;
            const d = await AiAnalysis.findById(id).lean();
            return d ? toAnalysis(d) : null;
        },
        async updateAnalysis(id, set) {
            await AiAnalysis.updateOne({ _id: id }, { $set: set });
        },
        async analysesToDeliver(at, limit) {
            const docs = await AiAnalysis.find({ delivery: 'pending', nextAttemptAt: { $lte: at } }).sort({ nextAttemptAt: 1 }).limit(limit).select('_id').lean();
            return docs.map((d) => String(d._id));
        },
        async listAnalyses(conversationId, limit = 20) {
            return (await AiAnalysis.find({ conversation: conversationId }).sort({ createdAt: -1 }).limit(limit).lean()).map(toAnalysis);
        },

        async listSummaries({ urgent = false, conversationId = null, limit = 50 } = {}) {
            const filter = {};
            if (urgent) filter.urgent = true;
            if (conversationId) filter.conversation = conversationId;
            return (await ClinicianSummary.find(filter).sort({ urgent: -1, createdAt: -1 }).limit(limit).lean()).map(toSummary);
        },

        async usageTotals(since) {
            const match = { $match: { createdAt: { $gte: since } } };
            const [byKind, totals] = await Promise.all([
                AiUsage.aggregate([
                    match,
                    { $group: { _id: { kind: '$kind', model: '$model' }, calls: { $sum: 1 }, usd: { $sum: '$costUsd' }, input: { $sum: '$input' },
                        output: { $sum: '$output' }, cacheRead: { $sum: '$cacheRead' }, cacheWrite: { $sum: '$cacheWrite' } } },
                    { $sort: { usd: -1 } },
                ]),
                AiUsage.aggregate([
                    match,
                    { $group: { _id: null, usd: { $sum: '$costUsd' }, conversations: { $addToSet: '$conversation' } } },
                    { $project: { usd: 1, conversations: { $size: '$conversations' } } },
                ]),
            ]);
            return {
                totalUsd: totals[0]?.usd || 0,
                conversations: totals[0]?.conversations || 0,
                byKindAndModel: byKind.map((r) => ({ kind: r._id.kind, model: r._id.model, calls: r.calls, usd: r.usd,
                    input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite })),
            };
        },
        measureAverageCost,

        async getSetting(key) {
            return (await AiSetting.findOne({ key }).lean())?.value ?? null;
        },
        async setSetting(key, value) {
            await AiSetting.updateOne({ key }, { $set: { value } }, { upsert: true });
        },
    };
}
