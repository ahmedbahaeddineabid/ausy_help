// End-of-conversation analysis (one call) and the urgent clinician summary.
// One analysis replaces three separate v1 jobs that each re-read the conversation:
//   cognisys            -> the patient's longitudinal profile (v1: lib/claude/cognisys.service.js, after almost every reply)
//   clinicianSummary    -> what the care team reads (new)
//   diagnostic          -> the patient's pre-diagnostic at 0 credits (v1: lib/claude/diagnostic.service.js)
// Fixed from v1: the Cognisys schema now includes confidence, source, unit and dimension factors (v1's prompt asked
// for them but the schema left them out, so they were always empty), confidence uses one 0-100 scale, and the
// analysis entry is a single object, as the prompt describes.

import { RISK_LABELS } from './chat.prompt.js';

const str = { type: 'string' };
const strArray = { type: 'array', items: str };

export const COGNISYS_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['facts', 'dimensions', 'analysisAppend', 'profile'],
    properties: {
        facts: {
            type: 'array',
            items: {
                type: 'object', additionalProperties: false,
                required: ['category', 'key', 'value', 'valueType', 'unit', 'confidence', 'source'],
                properties: {
                    category: str,
                    key: str,
                    value: { anyOf: [str, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: { anyOf: [str, { type: 'number' }, { type: 'boolean' }] } }] },
                    valueType: { type: 'string', enum: ['string', 'number', 'boolean', 'array', 'date'] },
                    unit: str,
                    confidence: { type: 'number' },
                    source: { type: 'string', enum: ['synthesized', 'confessed'] },
                },
            },
        },
        dimensions: {
            type: 'array',
            items: {
                type: 'object', additionalProperties: false,
                required: ['dimension', 'score', 'factors'],
                properties: { dimension: str, score: { type: 'number' }, factors: strArray },
            },
        },
        analysisAppend: {
            type: 'object', additionalProperties: false,
            required: ['analysisType', 'summary'],
            properties: { analysisType: { type: 'string', enum: ['initial', 'periodic', 'triggered', 'comprehensive'] }, summary: str },
        },
        profile: {
            type: 'object', additionalProperties: false,
            required: ['summary', 'tags', 'keyInsights', 'riskFactors', 'opportunities'],
            properties: { summary: str, tags: strArray, keyInsights: strArray, riskFactors: strArray, opportunities: strArray },
        },
    },
};

export const SUMMARY_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['urgent', 'urgency_reason', 'risk_flags', 'main_concerns', 'symptoms', 'triggers_stressors', 'sleep', 'appetite',
        'functioning', 'history', 'risk_factors', 'protective_factors', 'suggested_screening', 'consultation', 'patient_language', 'narrative'],
    properties: {
        urgent: { type: 'boolean' },
        urgency_reason: str,
        risk_flags: { type: 'array', items: { type: 'string', enum: RISK_LABELS } },
        main_concerns: str,
        symptoms: {
            type: 'array',
            items: {
                type: 'object', additionalProperties: false,
                required: ['symptom', 'duration', 'frequency_severity'],
                properties: { symptom: str, duration: str, frequency_severity: str },
            },
        },
        triggers_stressors: str,
        sleep: str,
        appetite: str,
        functioning: str,
        history: str,
        risk_factors: str,
        protective_factors: str,
        suggested_screening: { type: 'array', items: { type: 'string', enum: ['PHQ-9', 'GAD-7'] } },
        consultation: { type: 'string', enum: ['agreed', 'offered_not_agreed', 'declined', 'not_discussed'] },
        patient_language: str,
        narrative: str,
    },
};

export const DIAGNOSTIC_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['summary', 'concerns', 'recommendation'],
    properties: {
        summary: str,
        concerns: {
            type: 'array',
            items: {
                type: 'object', additionalProperties: false,
                required: ['name', 'severity', 'note'],
                properties: { name: str, severity: { type: 'string', enum: ['none', 'mild', 'moderate', 'severe'] }, note: str },
            },
        },
        recommendation: str,
    },
};

export function analysisSchema({ includeDiagnostic }) {
    const properties = { cognisys: COGNISYS_SCHEMA, clinicianSummary: SUMMARY_SCHEMA };
    if (includeDiagnostic) properties.diagnostic = DIAGNOSTIC_SCHEMA;
    return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

const NOT_DISCUSSED = 'not discussed';

function summaryRules(summaryLanguage) {
    return `Clinician summary rules:
- Write every text field in ${summaryLanguage}, whatever language the patient used. Quote the patient's own words briefly, in their language, for anything about risk.
- Use only what the patient actually said. When a field was not covered, write "${NOT_DISCUSSED}". Never guess, never infer or name a diagnosis, never suggest medication.
- Durations and frequencies as the patient described them ("about two weeks", "most nights").
- Tunisian Derja and dialectal Arabic: translate carefully. When you are not sure what a phrase means, quote it and write that its meaning is uncertain instead of guessing (for example, "ma3adech najjem" means "I can't take it anymore", not "I can't sleep").
- Do not assume the patient's gender. Use neutral wording unless the patient's own words show it (for example grammatical gender in French, Arabic or Derja).
- risk_flags lists only risks the patient's own words support. Automated signals and the assistant's questions are never enough on their own; an unconfirmed signal goes in the narrative, described as unconfirmed.
- urgent is true only when the patient's words show some sign of suicidal thoughts (even passive), self-harm, harming others, abuse or violence, or another acute crisis. If risk_flags is empty, urgent is false: an automated signal alone never makes a summary urgent. Explain urgency in urgency_reason, quoting the patient; otherwise urgency_reason is "${NOT_DISCUSSED}".
- Do not include names, places or other identifying details; write [name] or [place] instead.
- suggested_screening: PHQ-9 when low mood or loss of interest stands out, GAD-7 when worry or anxiety stands out; both or neither as fits.
- narrative: 4 to 8 sentences a busy clinician can read in 30 seconds, starting with the most important point.`;
}

export function urgentSystem(config) {
    return `You write an urgent internal summary of a support-chat conversation for the clinicians of Auzy, a mental-health platform in Tunisia. Automated checks have escalated this conversation; a clinician will read your summary before contacting the patient today.

${summaryRules(config.summaryLanguage)}`;
}

export function analysisSystem(config, { includeDiagnostic, freeConsultation }) {
    const sections = [`You analyse a support-chat conversation that has just ended on Auzy, a mental-health platform in Tunisia, and produce one JSON object.

General rules:
- Use only what the patient said; the assistant's own words are context, not facts about the patient.
- Automated screening signals come from software that can be wrong: mention them where they matter, but rely on the patient's words.
- Never name a diagnosis as certain and never suggest medication.

## cognisys: update to the patient's longitudinal profile
You receive the latest stored profile state (read-only). Propose only what this conversation adds or changes.
- facts: at most 10 durable facts with confidence of at least 70 (scale 0 to 100); key and category in English kebab-case; source "confessed" when the patient said it, "synthesized" when you inferred it; unit "" when not applicable. Skip ephemeral chat-only items and anything identical to the stored state.
- dimensions: at most 10, each a one-word lowercase name (for example "mood", "anxiety", "sleep", "stress"), a score from 0 to 100, and at most 5 short factors explaining it. Keep trends coherent with the stored scores; large changes need factors.
- analysisAppend: exactly one entry; summary of 1 to 3 objective sentences on what changed.
- profile: a concise summary reflecting the latest insights, and short, unique, normalized tags, keyInsights, riskFactors and opportunities.
- Never report, anywhere: which language(s) the patient speaks or prefers, or their national, ethnic or cultural origin. Stay on mental-health content: mood, symptoms, stressors, behaviour patterns, risk and care-seeking.
- Write the prose fields (profile texts, analysisAppend.summary, dimension factors) in the language the patient mostly used; keys and categories stay in English.

## clinicianSummary: what the care team reads
${summaryRules(config.summaryLanguage)}`];
    if (includeDiagnostic) {
        sections.push(`## diagnostic: the patient's pre-diagnostic (they see this)
A short, plain-language pre-screening for the patient: a summary of what the conversation suggests, and the specific concerns actually indicated (for example "Depression", "Anxiety", "Sleep disturbance"), each with a severity (none, mild, moderate or severe) and a one-sentence note. If nothing concerning came up, return an empty concerns list and a reassuring summary. This is a pre-screening, not a diagnosis: never claim certainty. End with a short recommendation ${freeConsultation ? 'encouraging the free 15-minute consultation with one of our professionals' : 'encouraging a consultation with one of our professionals'}. Write summary, concern names, notes and recommendation in the language the patient used; severity stays exactly one of the English values.`);
    }
    return sections.join('\n\n');
}
