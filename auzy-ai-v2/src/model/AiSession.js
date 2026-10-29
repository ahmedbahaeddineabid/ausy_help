import mongoose from 'mongoose';

const { Mixed, ObjectId } = mongoose.Schema.Types;

// AI state of one conversation: the Claude-format history of the current session (append-only, thinking
// blocks and tool calls included, which the Message collection doesn't keep), the escalation state and the
// per-message risk signals. One document per Conversation.
const aiSessionSchema = new mongoose.Schema(
    {
        conversation: { type: ObjectId, ref: 'Conversation', required: true, unique: true, index: true },
        profile: { type: ObjectId, ref: 'Profile', index: true },
        transcript: { type: [Mixed], default: [] },
        escalation: {
            active: { type: Boolean, default: false, index: true },
            since: Date,
            reason: String,
            clearedAt: Date,
            clearedBy: { type: ObjectId, ref: 'Profile' },
        },
        signals: { type: [Mixed], default: [] },
        turns: { type: Number, default: 0 },
        totalTurns: { type: Number, default: 0 },
        sessionNumber: { type: Number, default: 1 },
        needsAnalysis: { type: Boolean, default: false },
        previousContext: String,
        language: String,
        lastTurnAt: Date,
        lastAnalysisAt: Date,
        costUsd: { type: Number, default: 0 },          // current session, for the per-conversation ceiling
        totalCostUsd: { type: Number, default: 0 },
    },
    { timestamps: true, minimize: false },
);

aiSessionSchema.index({ needsAnalysis: 1, lastTurnAt: 1 });     // the API's idle poll (server/scheduler.js)

export const AiSession = mongoose.model('AiSession', aiSessionSchema);
