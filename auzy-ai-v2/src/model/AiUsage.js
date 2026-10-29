import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// One row per Claude call: what it cost and why it was made.
// kind: chat | second_opinion | urgent_summary | end_analysis
const aiUsageSchema = new mongoose.Schema(
    {
        conversation: { type: ObjectId, ref: 'Conversation', index: true },
        profile: { type: ObjectId, ref: 'Profile' },
        session: Number,                                // AiSession.sessionNumber: one sitting of the conversation
        kind: { type: String, required: true },
        model: { type: String, required: true },
        input: { type: Number, default: 0 },
        output: { type: Number, default: 0 },
        cacheRead: { type: Number, default: 0 },
        cacheWrite: { type: Number, default: 0 },
        costUsd: { type: Number, default: 0 },
        refused: { type: Boolean, default: false },
    },
    { timestamps: true },
);

aiUsageSchema.index({ createdAt: -1 });

export const AiUsage = mongoose.model('AiUsage', aiUsageSchema);
