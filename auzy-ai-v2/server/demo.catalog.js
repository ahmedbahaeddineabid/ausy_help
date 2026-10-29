// AUZY_MODE=demo: built-in stand-ins for auzy-backend, so the API can run before the callback endpoints exist.
// Three professionals, three screening tests, no appointments, an empty Cognisys profile; analyses stay in this API.
// The ids look like MongoDB ids but match nothing in Auzy. Also used by test/live.check.mjs.

export const DEMO_CONSULTANTS = [
    { _id: '6650000000000000000000a1', firstName: 'Amina', lastName: 'B.', title: 'Psychologue clinicienne', specialities: ['anxiété', 'dépression', 'stress au travail'],
        languages: ['fr', 'ar'], bio: 'Accompagne les adultes en situation de stress professionnel et de troubles du sommeil, en thérapie cognitive et comportementale.',
        consultationPrice: 60, currency: 'TND', email: 'amina@example.com', phone: '+216 00 000 001', availability: [{ day: 1, from: '09:00' }] },
    { _id: '6650000000000000000000a2', firstName: 'Karim', lastName: 'S.', title: 'Psychiatre', specialities: ['dépression', 'troubles anxieux'],
        languages: ['fr', 'ar', 'en'], bio: 'Consultations pour adultes, approche intégrative.', consultationPrice: 80, currency: 'TND', email: 'karim@example.com' },
    { _id: '6650000000000000000000a3', firstName: 'Leila', lastName: 'M.', title: 'Psychologue', specialities: ['violences conjugales', 'traumatisme'],
        languages: ['ar', 'fr'], bio: 'Spécialisée dans l\'accompagnement des victimes de violences.', consultationPrice: 50, currency: 'TND' },
];

export const DEMO_TESTS = [
    { _id: '6650000000000000000000b1', name: 'PHQ-9', description: 'Questionnaire de dépistage de la dépression (9 questions, 2 minutes).', questions: Array(9).fill({}) },
    { _id: '6650000000000000000000b2', name: 'GAD-7', description: 'Questionnaire de dépistage de l\'anxiété (7 questions, 2 minutes).', questions: Array(7).fill({}) },
    { _id: '6650000000000000000000b3', name: 'ISI', description: 'Index de sévérité de l\'insomnie (7 questions).', questions: Array(7).fill({}) },
];

export const demoServices = {
    async findProfiles(q, o) { return { profiles: DEMO_CONSULTANTS.slice(0, o.limit) }; },
    async listAppointmentsForProfile() { return []; },
    async publicListAgents(q) {
        const s = (q.search || '').toLowerCase();
        const hit = DEMO_TESTS.filter((t) => !s || `${t.name} ${t.description}`.toLowerCase().includes(s.split(' ')[0]));
        return { items: (hit.length ? hit : DEMO_TESTS).slice(0, q.limit) };
    },
};

export function demoAuzy() {
    return {
        mode: 'demo',
        services: demoServices,
        cognisys: {
            getSnapshot: async () => ({ profile: { summary: 'Pending summary', tags: [] }, facts: [], dimensions: [], analyses: [] }),
            apply: async (profileId, out) => ({ facts: out?.facts?.length || 0, dimensions: out?.dimensions?.length || 0 }),
        },
        deliverAnalysis: null,
    };
}
