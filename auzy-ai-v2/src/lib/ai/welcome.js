// The greeting that opens a conversation, before the patient's first message: fixed text in the chat language, no
// Claude call. It tells the patient that they are talking with an AI and that the care team receives a summary.
// THE ARABIC AND DERJA TEXTS MUST BE CONFIRMED BY NATIVE-SPEAKER CLINICIANS.

const TEXT = {
    en: {
        named: 'Hello, I\'m {name}, an AI support assistant.',
        unnamed: 'Hello, I\'m Auzy\'s AI support assistant.',
        body: 'I\'m here to listen and support you, and I can help you find a professional or a screening test. '
            + 'A summary of our conversation is shared with the care team, to help them support you. How are you feeling today?',
    },
    fr: {
        named: 'Bonjour, je suis {name}, une IA de soutien.',
        unnamed: 'Bonjour, je suis l\'IA de soutien d\'Auzy.',
        body: 'Je suis là pour vous écouter et vous soutenir, et je peux vous aider à trouver un professionnel ou un test de dépistage. '
            + 'Un résumé de notre échange est transmis à l\'équipe de soins, pour qu\'elle puisse mieux vous accompagner. '
            + 'Comment vous sentez-vous aujourd\'hui ?',
    },
    ar: {
        named: 'مرحبًا، أنا {name}، مساعد دعم يعمل بالذكاء الاصطناعي.',
        unnamed: 'مرحبًا، أنا مساعد الدعم في Auzy، وأعمل بالذكاء الاصطناعي.',
        body: 'أنا هنا لأستمع إليك وأساندك، ويمكنني مساعدتك في إيجاد مختص أو اختبار تقييم أولي. '
            + 'يُرسَل ملخص لمحادثتنا إلى فريق الرعاية ليتمكن من مرافقتك بشكل أفضل. كيف حالك اليوم؟',
    },
    aeb: {                                                                                  // draft: needs native review
        named: 'Aslema, ena {name}, assistant virtuel yekhdem bel IA.',
        unnamed: 'Aslema, ena l\'assistant virtuel mta3 Auzy, nekhdem bel IA.',
        body: 'Ena houni bech nesma3lek w nkoun m3ak, w najjem n3awnek bech tal9a spécialiste wala test d\'évaluation. '
            + 'Résumé mta3 el 7ki mte3na yetb3ath lel équipe mta3 el soins, bech yetab3ouk khir. Chnowa a7welek lyoum?',
    },
};

export const WELCOME_LANGUAGES = Object.keys(TEXT);

/** The greeting in `language` ('en' | 'fr' | 'ar' | 'aeb'; anything else: English), with the persona's name if it has one. */
export function welcomeText(language, name = '') {
    const t = TEXT[language] || TEXT.en;
    const who = name ? t.named.replace('{name}', () => name) : t.unnamed;
    return `${who} ${t.body}`;
}
