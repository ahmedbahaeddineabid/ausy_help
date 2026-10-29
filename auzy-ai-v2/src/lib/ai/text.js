// Text clean-up for what the patient sees. The stored conversation keeps Claude's original output.
//
// Claude sometimes puts Arabic script into Latin-script Derja, even when told not to (seen with Haiku 5.5 and
// Sonnet 5.5 in live tests): inside a word ("tعدي", "tلومش") or as whole words ("ymchi أكثر معاك؟").
// Converted to Arabizi (3 for ع, 7 for ح, 9 for ق, 5 for خ, 8 for غ ...):
//   - any word that mixes the two scripts
//   - every Arabic-script word of a reply that is clearly written in Latin script
// A reply written in Arabic script is left alone.

const ARABIZI = {
    'ء': '2', 'أ': 'a', 'إ': 'i', 'آ': 'a', 'ا': 'a', 'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'j', 'ح': '7', 'خ': '5', 'د': 'd',
    'ذ': 'dh', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'ch', 'ص': 's', 'ض': 'dh', 'ط': 't', 'ظ': 'dh', 'ع': '3', 'غ': '8',
    'ف': 'f', 'ق': '9', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'h', 'ة': 'a', 'و': 'ou', 'ي': 'i', 'ى': 'a',
    'ئ': '2', 'ؤ': '2', 'ڤ': 'v', 'پ': 'p',
};
const ARABIC_MARKS = /[ً-ْٰـ]/g;      // short-vowel marks and tatweel
const ARABIC_LETTER = /[؀-ۿ]/g;

const toArabizi = (word) => word.replace(ARABIC_MARKS, '').replace(ARABIC_LETTER, (c) => ARABIZI[c] ?? '');

export function fixMixedScript(text) {
    const s = text || '';
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    const arabic = (s.match(ARABIC_LETTER) || []).length;
    const latinReply = arabic > 0 && latin > arabic * 3;
    const out = s.replace(/[\p{L}\p{M}\d']+/gu, (word) => {
        if (!/[؀-ۿ]/.test(word)) return word;
        return /[A-Za-z]/.test(word) || latinReply ? toArabizi(word) : word;
    });
    return latinReply ? out.replace(/؟/g, '?').replace(/،/g, ',').replace(/؛/g, ';') : out;
}
