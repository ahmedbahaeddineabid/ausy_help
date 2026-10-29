// Emergency text shown in the escalation banner, and a light language guess for choosing it.
// THE ARABIC AND DERJA TEXTS, AND THE EMERGENCY NUMBER, MUST BE CONFIRMED BY NATIVE-SPEAKER CLINICIANS.

const TEXT = {
    en: 'Thank you for telling me. You don\'t have to go through this alone. A member of our care team will contact you today. '
        + 'If you or anyone else is in immediate danger, call {num} (SAMU) or go to the nearest emergency department now.',
    fr: 'Merci de me l\'avoir dit. Vous n\'êtes pas seul·e face à cela. Un membre de notre équipe de soins va vous contacter aujourd\'hui. '
        + 'Si vous ou quelqu\'un d\'autre êtes en danger immédiat, appelez le {num} (SAMU) ou rendez-vous aux urgences les plus proches.',
    ar: 'شكرًا لأنك أخبرتني. لست وحدك في هذا. سيتواصل معك أحد أفراد فريق الرعاية اليوم. '
        + 'إذا كنت أنت أو أي شخص آخر في خطر الآن، اتصل بالرقم {num} (الإسعاف) أو توجه فورًا إلى أقرب قسم استعجالي.',
    aeb: 'Ya3tik essa7a elli 9oltli. Enti mouch wa7dek. Wa7ed mel équipe mte3na bech yetsel bik lyoum. '      // draft: needs native review
        + 'Ken enti wala 7ad ekher fi khatar tawa, kallem {num} (SAMU) wala emchi lel urgence el a9rab.',
};

export function emergencyText(language, number) {
    return (TEXT[language] || TEXT.en).replace('{num}', number);
}

const ARABIC = /[؀-ۿ]/;
// Arabizi token: letters and a 2/3/5/7/8/9 inside one word ("n7eb", "ta3bana", "3andi"), not "3am" or "4pm".
const ARABIZI_TOKEN = /^(?=.*[a-z])(?:[a-z]+[235789][a-z0-9]*|[235789][a-z]{3,}[a-z0-9]*)$/i;
// Very common Derja words written without numerals: many short Derja messages have only one numeral word
// ("Nheb nmout, ma3adech najjem"), so numerals alone miss them.
const DERJA_WORDS = new Set(['nheb', 'nhib', 'nhebb', 'nmout', 'barcha', 'barsha', 'mouch', 'mich', 'kifech', 'kifesh', 'chnowa',
    'chnoua', 'tawa', 'bech', 'besh', 'behi', 'ena', 'enti', 'inti', 'lyoum', 'mte3i', 'mta3', 'najjem', 'nejjem', 'mli7', 'mlih',
    'aslema', 'yezzi', 'barra', 'famma', 'fama', 'brabbi', 'rabbi', 'khoya', 'okhti', 'sahbi', 'zeda', 'ken', 'chwaya', 'chouia']);
// French words that are not also common English words ("pour", "comment", "ton" are left out); two or more -> French.
// Matched on whole words split on anything but letters, so accented words ("ça", "fatiguée") and elisions
// ("j'ai", "c'est") count too.
const FRENCH_WORDS = new Set(['je', 'j', 'tu', 'vous', 'nous', 'suis', 'est', 'sont', 'pas', 'mais', 'avec', 'dans', 'très', 'trop',
    'mon', 'ma', 'mes', 'tes', 'ses', 'ça', 'les', 'des', 'ces', 'une', 'rien', 'depuis', 'encore', 'toujours', 'jamais', 'beaucoup',
    'parce', 'quand', 'pourquoi', 'moi', 'être', 'avoir', 'qui', 'quoi', 'qu', 'aujourd', 'dors', 'dormir', 'sommeil', 'travail',
    'fatigué', 'fatiguée', 'temps', 'bonjour', 'merci']);

export function isArabizi(text) {
    const tokens = (text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return tokens.filter((t) => ARABIZI_TOKEN.test(t) || DERJA_WORDS.has(t)).length >= 2;
}

export function hasArabicScript(text) {
    return ARABIC.test(text || '');
}

/** 'ar' | 'aeb' | 'fr' | 'en' from the patient's own words (for the emergency banner and the analysis model). */
export function guessLanguage(text) {
    if (hasArabicScript(text)) return 'ar';
    if (isArabizi(text)) return 'aeb';
    if ((text || '').toLowerCase().split(/[^\p{L}]+/u).filter((w) => FRENCH_WORDS.has(w)).length >= 2) return 'fr';
    return 'en';
}
