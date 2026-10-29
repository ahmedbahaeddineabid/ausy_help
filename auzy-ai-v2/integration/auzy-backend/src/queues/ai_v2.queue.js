// AI v2 for the test accounts: consumes ai_v2_request (pushed by the patched user_message.queue.js for profiles in
// AI_V2_TEST_PROFILES), asks the Auzy AI API for the reply and saves it like today's consumer does
// (createAssistantMessage -> Socket.IO, cards, the master's library). Everyone else stays on completion_request.
// If the API can't be reached, the message is answered by today's chat instead.
// Loaded by user_message.queue.js (import "./ai_v2.queue.js"), like completion_request.queue.js.

import { consumeFromQueue, pushToQueue } from '../config/rabbit.config.js';
import { redisConnect, setNxEx, getRedis } from '../config/redis.config.js';
import { Message } from '../model/Message.js';
import { Profile } from '../model/Profile.js';
import { getConversationByIdPopulated, createAssistantMessage } from '../services/chat.service.js';
import { getLatestDiagnosticForProfile } from '../services/diagnostic.service.js';
import assistantService from '../services/assistant.service.js';
import libraryService from '../services/library.service.js';
import { maybeTriggerDiagnostic } from '../lib/claude/diagnostic.service.js';
import { sendTurn } from '../lib/ai-v2/ai-v2.client.js';

const RECENT_LIMIT = 30;           // messages read to find the new ones
const HISTORY = 6;                 // earlier messages sent along; the API uses them only for a conversation's first AI v2 turn
const LOCK_TTL_SECONDS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One turn at a time per conversation, across every worker: quick successive messages become one turn. */
async function withConversationLock(conversationId, fn, waitMs = 150000) {
    await redisConnect();
    const key = `ai:v2:lock:${conversationId}`;
    const deadline = Date.now() + waitMs;
    while (!(await setNxEx(key, '1', LOCK_TTL_SECONDS))) {
        if (Date.now() > deadline) throw new Error(`[ai-v2] lock timeout for conversation ${conversationId}`);
        await sleep(250);
    }
    try {
        return await fn();
    } finally {
        await getRedis().del(key).catch(() => {});
    }
}

/** Same rule as maybeTriggerDiagnostic (credits are checked by the caller): eligible, and no pre-diagnostic yet. */
async function isFreeConsultationDue(profileId) {
    const profile = await Profile.findById(profileId).select('freeConsultationEligible');
    if (!profile || profile.freeConsultationEligible === false) return false;
    return !(await getLatestDiagnosticForProfile(profileId));
}

const personaOf = (a) => (a ? {
    name: a.name, description: a.description, domain: a.domain, behavior: a.behavior, rules: a.rules, personalization: a.personalization,
} : null);

consumeFromQueue('ai_v2_request', async (content) => {
    const { conversation, creditsRemaining = null } = content || {};
    if (!conversation) throw new Error('Invalid queue payload for ai_v2_request');
    const conversationId = String(conversation);

    await withConversationLock(conversationId, async () => {
        const convo = await getConversationByIdPopulated(conversationId);
        if (!convo) throw new Error('Conversation not found for ai_v2_request');

        // Everything since the last assistant message; a duplicate job finds nothing new and stops here.
        // System messages (the chat-language switch) travel as notes.
        const recent = (await Message.find({ conversation: conversationId }).sort({ createdAt: -1, _id: -1 }).limit(RECENT_LIMIT).lean()).reverse();
        const lastAssistant = recent.map((m) => m.role).lastIndexOf('assistant');
        const fresh = recent.slice(lastAssistant + 1);
        const userTexts = fresh.filter((m) => m.role === 'user' && String(m.content || '').trim()).map((m) => String(m.content).trim());
        if (!userTexts.length) return;
        const notes = fresh.filter((m) => m.role === 'system' && String(m.content || '').trim()).map((m) => String(m.content).trim());
        const history = recent.slice(0, lastAssistant + 1).filter((m) => m.role === 'user' || m.role === 'assistant')
            .slice(-HISTORY).map((m) => ({ role: m.role, content: String(m.content || '') }));

        const profileId = String(convo.profile);
        const usingDefaultPersona = !convo.currentAssistant;
        const assistant = convo.currentAssistant || await assistantService.getGlobalDefaultAssistant();
        const patientMessage = userTexts.join('\n\n');

        let result;
        try {
            result = await sendTurn({
                conversationId, profileId, text: patientMessage, notes, history, persona: personaOf(assistant), creditsRemaining,
                freeConsultationEligible: creditsRemaining === 0 ? await isFreeConsultationDue(profileId) : false,
            });
        } catch (e) {
            console.error(`[ai-v2] Auzy AI API unavailable, today's chat answers instead: ${e?.message || e}`);
            await pushToQueue('completion_request', { conversation: conversationId });
            if (creditsRemaining === 0) {
                maybeTriggerDiagnostic(profileId, conversationId).catch((err) => console.error('Failed to generate diagnostic:', err?.message));
            }
            return;
        }

        await createAssistantMessage(conversationId, {
            content: result.reply,
            profiles: result.cards.profiles.length ? result.cards.profiles : undefined,
            appointments: result.cards.appointments.length ? result.cards.appointments : undefined,
            tests: result.cards.tests.length ? result.cards.tests : undefined,
            // Read by the ChatWindow.jsx patch: the emergency banner stays visible while the conversation is escalated.
            metadata: { ai: { version: 2, model: result.model, escalated: result.escalated, emergencyText: result.emergencyText || undefined } },
        });

        // The master's default persona answered -> capture the pair into her library (as today).
        if (usingDefaultPersona && assistant && !result.cards.profiles.length && !result.error) {
            try {
                await libraryService.logInteraction({
                    masterId: assistant.createdBy, assistantId: assistant._id, conversationId, patientId: convo.profile,
                    patientMessage, response: result.reply,
                });
            } catch (e) {
                console.error('[ai-v2] failed to log library interaction:', e?.message);
            }
        }
    });
});
