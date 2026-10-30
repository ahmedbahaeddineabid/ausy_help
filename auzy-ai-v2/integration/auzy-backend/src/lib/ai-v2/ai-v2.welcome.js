// AI v2 for the test accounts: the assistant's greeting at the top of an empty conversation, from the Auzy AI API
// (fixed text, no Claude call, no credit). Called by the patched chat.route.js when the patient opens the chat.
// The greeting is then the conversation's last assistant message, so queues/ai_v2.queue.js sends it to the API as
// history with the patient's first message, and the first reply doesn't greet them again.

import { redisConnect, setNxEx, getRedis } from '../../config/redis.config.js';
import { Message } from '../../model/Message.js';
import { createAssistantMessage } from '../../services/chat.service.js';
import assistantService from '../../services/assistant.service.js';
import { getWelcome } from './ai-v2.client.js';

/**
 * Saves the greeting as the first message of an empty conversation, once, even when the chat is opened twice at the
 * same time. Never throws: without the API, the chat opens empty, as today.
 * @param convo     the conversation, as getOrCreateConversation returns it (currentAssistant populated)
 * @param language  'en' | 'fr' | 'ar'
 */
export async function sendWelcome(convo, language) {
    const conversationId = String(convo._id);
    const key = `ai:v2:welcome:${conversationId}`;
    let locked = false;
    try {
        if (await Message.exists({ conversation: conversationId })) return;
        await redisConnect();
        locked = await setNxEx(key, '1', 60);
        if (!locked) return;
        const assistant = convo.currentAssistant || await assistantService.getGlobalDefaultAssistant();
        const { text } = await getWelcome({ language, name: assistant?.name });
        await createAssistantMessage(conversationId, { content: text, metadata: { ai: { version: 2, welcome: true } } });
    } catch (e) {
        console.error(`[ai-v2] no greeting for conversation ${conversationId}, the chat opens empty: ${e?.message || e}`);
        if (locked) await getRedis().del(key).catch(() => {});       // the next opening tries again
    }
}
