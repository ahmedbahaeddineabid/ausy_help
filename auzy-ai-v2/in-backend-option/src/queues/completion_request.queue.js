// Replacement for auzy-backend's src/queues/completion_request.queue.js (AI v2).
// Same input (the completion_request queue), same output (an assistant Message with card ids, emitted over
// Socket.IO by createAssistantMessage), same library logging. The AI work itself is in lib/ai/turn.service.js.
// Removed: the per-reply Cognisys trigger (now once per conversation, see ai_session.scheduler.js) and the
// canned "Here are recommended consultants for you." text, which could replace a safety reply.

import { consumeFromQueue, pushToQueue } from '../config/rabbit.config.js';
import { Message } from '../model/Message.js';
import { getConversationByIdPopulated, createAssistantMessage } from '../services/chat.service.js';
import { findProfiles, findProfileById } from '../services/profile.service.js';
import { listAppointmentsForProfile } from '../services/appointment.service.js';
import agentService from '../services/agent.service.js';
import assistantService from '../services/assistant.service.js';
import libraryService from '../services/library.service.js';
import cognisysSvc from '../services/cognisys.service.js';
import { getAi } from '../lib/ai/index.js';
import { createToolbox } from '../lib/ai/tools/index.js';
import { newSession } from '../lib/ai/turn.service.js';
import { withConversationLock, scheduleIdleAnalysis, runEndAnalysis, isDiagnosticDue } from './ai_session.scheduler.js';

const RECENT_LIMIT = 30;

const asText = (m) => `${m.role === 'user' ? 'PATIENT' : 'ASSISTANT'}: ${String(m.content || '').trim()}`;

/** First v2 turn of a conversation that started under v1: carry continuity from Cognisys and the last messages. */
async function seedFromV1(ai, conversationId, profileId, earlier) {
    if (await ai.store.loadSession(conversationId)) return;
    const profile = await cognisysSvc.getCognisysProfileByProfileId(profileId).catch(() => null);
    const recent = earlier.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-ai.config.contextMessages).map(asText).join('\n');
    if (!profile?.summary && !recent) return;
    await ai.store.saveSession({
        ...newSession(conversationId, profileId),
        previousContext: `Profile summary: ${profile?.summary || 'none'}\nLast messages:\n${recent || 'none'}`,
    });
}

consumeFromQueue('completion_request', async (content) => {
    const { conversation, creditsRemaining = null } = content || {};
    if (!conversation) throw new Error('Invalid queue payload for completion request');
    const conversationId = String(conversation);

    await withConversationLock(conversationId, async () => {
        const ai = getAi();
        const convo = await getConversationByIdPopulated(conversationId);
        if (!convo) throw new Error('Conversation not found for completion request');

        // Everything since the last assistant message: several quick patient messages become one turn, and a
        // duplicate job finds nothing new and stops here. System messages (the chat-language switch) become notes.
        const recent = (await Message.find({ conversation: conversationId }).sort({ createdAt: -1, _id: -1 }).limit(RECENT_LIMIT).lean()).reverse();
        const lastAssistant = recent.map((m) => m.role).lastIndexOf('assistant');
        const fresh = recent.slice(lastAssistant + 1);
        const userTexts = fresh.filter((m) => m.role === 'user' && String(m.content || '').trim()).map((m) => String(m.content).trim());
        if (!userTexts.length) return;
        const notes = fresh.filter((m) => m.role === 'system' && String(m.content || '').trim()).map((m) => String(m.content).trim());

        const profileId = String(convo.profile);
        const usingDefaultPersona = !convo.currentAssistant;
        const assistant = convo.currentAssistant || await assistantService.getGlobalDefaultAssistant();
        const ownerProfile = await findProfileById(convo.profile);
        await seedFromV1(ai, conversationId, profileId, recent.slice(0, lastAssistant + 1));

        const freeConsultation = creditsRemaining === 0 ? await isDiagnosticDue(profileId) : false;
        const toolbox = createToolbox({
            services: { findProfiles, listAppointmentsForProfile, publicListAgents: (q) => agentService.publicListAgents(q) },
            profileId: convo.profile,
            role: ownerProfile?.role,
        });

        const result = await ai.turns.handleTurn({
            conversationId, profileId, assistant, toolbox,
            userText: userTexts.join('\n\n'), notes, creditsRemaining, freeConsultation,
        });

        await createAssistantMessage(conversationId, {
            content: result.reply,
            profiles: result.cards.profiles.length ? result.cards.profiles : undefined,
            appointments: result.cards.appointments.length ? result.cards.appointments : undefined,
            tests: result.cards.tests.length ? result.cards.tests : undefined,
            metadata: { ai: { model: result.model, escalated: result.escalated, emergencyText: result.emergencyText || undefined } },
        });

        // The master's default persona answered -> capture the pair into her library (unchanged from v1).
        if (usingDefaultPersona && assistant && !result.cards.profiles.length && !result.error) {
            try {
                await libraryService.logInteraction({
                    masterId: assistant.createdBy, assistantId: assistant._id, conversationId, patientId: convo.profile,
                    patientMessage: userTexts.join('\n\n'), response: result.reply,
                });
            } catch (e) {
                console.error('[completion_request] failed to log library interaction:', e?.message);
            }
        }

        // Follow-up jobs run outside this turn (they take the lock themselves when needed).
        if (result.jobs.includes('urgent_summary')) {
            ai.analysis.urgentSummary(conversationId).catch((e) => console.error('[ai] urgent summary failed:', e?.message || e));
        }
        if (result.jobs.includes('end_analysis')) {
            setImmediate(() => runEndAnalysis(conversationId, 'credits_exhausted').catch(async (e) => {
                console.error('[ai] end analysis failed, retrying via the idle scheduler:', e?.message || e);
                await scheduleIdleAnalysis(conversationId).catch(() => {});    // the retry still produces the pre-diagnostic
            }));
        } else {
            await scheduleIdleAnalysis(conversationId);
        }
    });
});

export const enqueueCompletionRequest = async (payload) => {
    if (!payload?.conversation) throw new Error('Invalid payload for completion_request');
    await pushToQueue('completion_request', payload);
};
