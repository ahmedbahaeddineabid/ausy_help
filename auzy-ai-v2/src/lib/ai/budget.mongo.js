// Measures the real average cost per finished conversation from the AiUsage ledger, for the budget governor
// and the GET /v1/costs report. A finished conversation = a session that got its end-of-conversation analysis;
// its cost = every Claude call of that session (replies, second opinions, urgent summary, analysis).

import { AiUsage } from '../../model/AiUsage.js';

export async function measureAverageCost(windowDays) {
    const since = new Date(Date.now() - windowDays * 86400000);
    const [row] = await AiUsage.aggregate([
        { $match: { createdAt: { $gte: since }, session: { $ne: null } } },
        {
            $group: {
                _id: { conversation: '$conversation', session: '$session' },
                usd: { $sum: '$costUsd' },
                ended: { $max: { $cond: [{ $eq: ['$kind', 'end_analysis'] }, 1, 0] } },
            },
        },
        { $match: { ended: 1 } },
        { $group: { _id: null, avg: { $avg: '$usd' }, max: { $max: '$usd' }, n: { $sum: 1 } } },
    ]);
    return { since, avgUsd: row?.avg ?? null, maxUsd: row?.max ?? null, samples: row?.n ?? 0 };
}
