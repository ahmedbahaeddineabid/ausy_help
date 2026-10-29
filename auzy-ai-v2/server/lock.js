// One turn (or session close, or escalation change) at a time per conversation, in this process.
// The API runs as a single instance for testing; several instances would need a shared lock
// (for example the Redis lock in in-backend-option/src/queues/ai_session.scheduler.js).

export function createLock() {
    const tails = new Map();
    return async function withLock(key, fn) {
        const previous = tails.get(key) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        const tail = previous.then(() => current);
        tails.set(key, tail);
        await previous;
        try {
            return await fn();
        } finally {
            release();
            if (tails.get(key) === tail) tails.delete(key);
        }
    };
}
