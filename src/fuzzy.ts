// Fuzzy matching for completion and pickers: the query's characters must
// appear in order; runs, word starts and a matching prefix score higher.

function isWordStart(text: readonly string[], i: number): boolean {
    if (i === 0) return true;
    const prev = text[i - 1];
    const c = text[i];
    if (!/[\p{L}\p{N}]/u.test(prev)) return true;
    return /\p{Lowercase}/u.test(prev) && /\p{Uppercase}/u.test(c);
}

/** How well `query` matches `text` (higher is better), or undefined if it
 * doesn't. Case is ignored, though matching case scores a little higher. */
export function fuzzyScore(query: string, text: string): number | undefined {
    if (query === '') return 0;
    const q = Array.from(query);
    const t = Array.from(text);
    let score = 0;
    let ti = 0;
    let prev = -2;
    for (const qc of q) {
        const lower = qc.toLowerCase();
        while (ti < t.length && t[ti].toLowerCase() !== lower) ti++;
        if (ti === t.length) return undefined;
        score += 1;
        if (ti === prev + 1) score += 4;
        if (isWordStart(t, ti)) score += 3;
        if (t[ti] === qc) score += 1;
        prev = ti;
        ti++;
    }
    if (t.slice(0, q.length).join('').toLowerCase() === query.toLowerCase()) score += 10;
    // Prefer shorter texts among equal matches.
    return score - t.length / 100;
}
