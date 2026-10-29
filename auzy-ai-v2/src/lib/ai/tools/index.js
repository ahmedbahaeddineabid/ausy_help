// The three tools Claude can call, with the same names and inputs as auzy-backend's
// consultant.tool.js / appointment.tool.js / test.tool.js, so the frontend cards keep working.
// Change from v1: Claude receives a compact projection of each result (about 1,000 tokens for 5
// professionals instead of ~8,300 for 10), while the full result is still used to build the cards.
// The field lists below are best guesses at the Profile / Appointment / Agent models: adjust them
// to the real schemas, then re-measure with the cost script.

const CONSULTANT_FIELDS = ['_id', 'firstName', 'lastName', 'title', 'speciality', 'specialities', 'specialty', 'specialties',
    'domain', 'languages', 'city', 'gender', 'bio', 'description', 'price', 'consultationPrice', 'currency', 'rating',
    'yearsOfExperience'];
const APPOINTMENT_FIELDS = ['_id', 'status', 'startTime', 'endTime', 'start', 'end', 'date', 'scheduledAt', 'type', 'mode',
    'consultant', 'patient', 'price', 'currency'];
const TEST_FIELDS = ['_id', 'name', 'title', 'description', 'category', 'duration', 'questionsCount'];

const MAX_STRING = 160;
const MAX_ARRAY = 5;

function personName(v) {
    const name = [v.firstName, v.lastName].filter(Boolean).join(' ') || v.name;
    return name ? String(name) : null;
}

/** Keep only `fields`, shorten long text, turn populated people into names; drop everything else. */
export function compact(doc, fields) {
    if (!doc || typeof doc !== 'object') return doc;
    const out = {};
    for (const key of fields) {
        let v = doc[key];
        if (v === undefined || v === null || v === '') continue;
        if (v instanceof Date) v = v.toISOString();
        else if (typeof v === 'object' && v._bsontype) v = String(v);            // ObjectId
        else if (Array.isArray(v)) v = v.filter((x) => typeof x !== 'object').slice(0, MAX_ARRAY);
        else if (typeof v === 'object') v = personName(v);
        if (typeof v === 'string' && v.length > MAX_STRING) v = `${v.slice(0, MAX_STRING)}…`;
        if (v !== null && !(Array.isArray(v) && !v.length)) out[key] = v;
    }
    return out;
}

export const TOOL_DEFINITIONS = [
    {
        name: 'find_consultants',
        description: 'Find the platform\'s professionals (therapists, psychologists, coaches) the person could book a consultation with. '
            + 'Results are shown to the person as cards.',
        input_schema: {
            type: 'object',
            properties: {
                search: { type: 'string', description: 'Optional search term, e.g. a concern ("anxiety"), a speciality or a language' },
                limit: { type: 'integer', description: 'Number of professionals to return (1-10, default 5)' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'get_my_appointments',
        description: 'Look up the person\'s own appointments. Use it whenever they ask about an upcoming or past session, or whether they have anything booked.',
        input_schema: {
            type: 'object',
            properties: {
                when: { type: 'string', enum: ['upcoming', 'past'], description: 'Upcoming or past appointments; omit for both.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'find_tests',
        description: 'Find published screening tests (for example PHQ-9 for depression, GAD-7 for anxiety, or tests about stress or sleep). '
            + 'Use it when a concern the person describes could be usefully screened, or when they ask about tests. Results are shown as cards.',
        input_schema: {
            type: 'object',
            properties: {
                search: { type: 'string', description: 'Search term matched against a test\'s name or description, e.g. "anxiety", "PHQ-9", "sleep"' },
                limit: { type: 'integer', description: 'Number of tests to return (1-5, default 3)' },
            },
            additionalProperties: false,
        },
    },
];

const clamp = (n, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Number(n) : d));

/**
 * Tools bound to one conversation. The profile id and role come from the server, never from Claude's input,
 * so Claude can only ever see this person's own appointments.
 * services: { findProfiles, listAppointmentsForProfile, publicListAgents } from auzy-backend.
 */
export function createToolbox({ services, profileId, role }) {
    const run = {
        async find_consultants(input) {
            const raw = await services.findProfiles(
                { role: 'consultant', search: input.search || '' },
                { limit: clamp(input.limit, 1, 10, 5), page: 1, sortBy: 'createdAt', sortOrder: 'desc' },
            );
            const profiles = raw?.profiles || [];
            return { raw: { profiles }, forModel: { profiles: profiles.map((p) => compact(p, CONSULTANT_FIELDS)) } };
        },
        async get_my_appointments(input) {
            const appointments = await services.listAppointmentsForProfile(profileId, role, { when: input.when, limit: 10 }) || [];
            return { raw: { appointments }, forModel: { appointments: appointments.map((a) => compact(a, APPOINTMENT_FIELDS)) } };
        },
        async find_tests(input) {
            const res = await services.publicListAgents({ search: input.search || '', limit: clamp(input.limit, 1, 5, 3) });
            const tests = res?.items || [];
            return { raw: { tests }, forModel: { tests: tests.map((t) => compact(t, TEST_FIELDS)) } };
        },
    };
    return {
        definitions: TOOL_DEFINITIONS,
        /** -> { raw, forModel } ; throws on unknown tool or service error (the caller turns that into an is_error result) */
        async execute(name, input = {}) {
            if (!run[name]) throw new Error(`No executor registered for tool: ${name}`);
            return run[name](input || {});
        },
    };
}

/** Card ids for the assistant message, merged across every tool call of the turn (same shape as v1). */
export function cardIds(toolResults = []) {
    const ids = (name, key) => [...new Set(toolResults.filter((t) => t.name === name)
        .flatMap((t) => t.raw?.[key] || []).map((x) => x?._id).filter(Boolean).map(String))];
    return {
        profiles: ids('find_consultants', 'profiles'),
        appointments: ids('get_my_appointments', 'appointments'),
        tests: ids('find_tests', 'tests'),
    };
}
