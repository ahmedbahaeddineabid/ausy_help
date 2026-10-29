// One chat reply from Claude, including the tool loop. Replaces lib/claude/chat.service.js#createChatCompletion
// for patient chat. Differences from v1:
//  - prompt caching: tools + base prompt + persona (system blocks) and the conversation history (top-level breakpoint)
//  - adaptive thinking with an effort level per model; thinking blocks are kept and passed back unchanged
//  - tool results go to Claude in compact form (see tools/index.js); full results are kept for the cards
//  - returns every message the turn added, so the caller can store the history append-only

import { riskTag, stripTags } from './prompts/chat.prompt.js';

const textOf = (content) => (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');

/**
 * @returns {{ text, riskFlag, refused, appended, toolResults, responses, stopReason }}
 *   text: the reply shown to the patient (tags removed); empty when Claude gave no final text
 *   appended: messages this turn added after `messages` (assistant tool calls, tool results, final reply)
 *   responses: raw API responses, one per request, for the usage ledger
 */
export async function callClaude({ client, config, model, effort = null, system, toolbox = null, messages, requestOptions = {} }) {
    const appended = [];
    const toolResults = [];
    const responses = [];
    for (let round = 0; round < config.maxToolRoundtrips; round += 1) {
        const params = {
            model,
            max_tokens: config.maxTokens[model],
            system,
            thinking: { type: 'adaptive' },
            output_config: { effort: effort || config.effort[model] },
            cache_control: { type: 'ephemeral' },          // automatic breakpoint on the newest history block
            messages: [...messages, ...appended],
        };
        if (toolbox) params.tools = toolbox.definitions;  // tool_choice defaults to auto (forced choices 400 on 5.5 models)
        const res = await client.messages.create(params, { timeout: config.chatTimeoutMs, ...requestOptions });
        responses.push(res);

        if (res.stop_reason === 'refusal') {
            return { text: '', riskFlag: null, refused: true, appended: [], toolResults, responses, stopReason: res.stop_reason };
        }
        const content = res.content || [];
        const toolUses = content.filter((b) => b.type === 'tool_use');
        appended.push({ role: 'assistant', content });      // unchanged: thinking blocks must be passed back as returned

        if (!toolUses.length || !toolbox) {
            const raw = textOf(content);
            return { text: stripTags(raw), riskFlag: riskTag(raw), refused: false, appended, toolResults, responses, stopReason: res.stop_reason };
        }

        // Run every tool call of this round and return all results in one user message
        // (splitting them across messages teaches the model to stop calling tools in parallel).
        const results = [];
        for (const tu of toolUses) {
            try {
                const { raw, forModel } = await toolbox.execute(tu.name, tu.input);
                toolResults.push({ name: tu.name, raw });
                results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(forModel) });
            } catch (e) {
                results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ error: e?.message || 'Tool failed' }), is_error: true });
            }
        }
        appended.push({ role: 'user', content: results });
    }
    // Still calling tools after the last round: no final reply. The caller treats this like an empty reply.
    return { text: '', riskFlag: null, refused: false, appended, toolResults, responses, stopReason: 'max_tool_roundtrips' };
}
