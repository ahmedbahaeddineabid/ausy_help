// Budget policy: keeps the average cost per 1,000 conversations inside the target band
// (default $50-80) whatever the mix of languages and crises, by choosing a quality level.
//
//   level 0  economy   every routine reply on the routine model (Haiku)
//   level 1  standard  routine replies on the careful model (Sonnet, low effort) for AI_QUALITY_LANGUAGES (Arabic, Derja)
//   level 2  premium   every routine reply on the careful model
//
// Risk handling never depends on the level: second opinions, escalated conversations, urgent summaries
// and Arabic/Derja analyses always use the careful model.

export const LEVELS = ['economy', 'standard', 'premium'];

/**
 * Daily decision from the measured average cost of finished conversations over the last window.
 * Steps down at once when over budget; steps up only after a cooldown, to avoid flip-flopping.
 */
export function nextLevel({ current, avgUsd, samples, daysSinceChange, budget }) {
    if (avgUsd == null || samples < budget.minSamples) return current;
    const per1000 = avgUsd * 1000;
    if (per1000 > budget.targetMaxPer1000Usd) return Math.max(0, current - 1);
    if (per1000 < budget.targetMinPer1000Usd && daysSinceChange >= budget.minDaysBetweenUpgrades) {
        return Math.min(LEVELS.length - 1, current + 1);
    }
    return current;
}

/** In-process holder of the current level (set by the daily governor in server/scheduler.js). */
export function createBudgetLevel(budget) {
    let level = Math.min(LEVELS.length - 1, Math.max(0, budget.startLevel));
    return {
        level: () => level,
        set(next) { level = Math.min(LEVELS.length - 1, Math.max(0, Number(next) || 0)); },
        name: () => LEVELS[level],
    };
}

/** Is this conversation's routine reply written by the careful model at the current level? */
export function usesCarefulForRoutine(level, language, budget) {
    return level >= 2 || (level >= 1 && budget.qualityLanguages.includes(language));
}
