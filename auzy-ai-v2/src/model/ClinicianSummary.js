import mongoose from 'mongoose';

const { Mixed, ObjectId } = mongoose.Schema.Types;

// What the care team reads about a conversation. trigger: escalation | credits_exhausted | idle
// summary: the clinicianSummary JSON (concerns, symptoms, sleep, appetite, functioning, history, risk and
// protective factors, suggested screening, consultation status, narrative).
const clinicianSummarySchema = new mongoose.Schema(
    {
        conversation: { type: ObjectId, ref: 'Conversation', required: true, index: true },
        profile: { type: ObjectId, ref: 'Profile', index: true },
        trigger: { type: String, required: true },
        model: String,
        urgent: { type: Boolean, default: false },
        summary: { type: Mixed, required: true },
        reviewedAt: Date,
        reviewedBy: { type: ObjectId, ref: 'Profile' },
    },
    { timestamps: true },
);

clinicianSummarySchema.index({ urgent: -1, createdAt: -1 });

export const ClinicianSummary = mongoose.model('ClinicianSummary', clinicianSummarySchema);
