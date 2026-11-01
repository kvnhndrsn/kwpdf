// Reconcile plan for the highlight overlay.
//
// Kept dependency-free (no DOM, no state) so the decision — which marks to
// create, which to reposition, which to drop — can be tested in Node. The
// renderer in pdf-highlights.ts is then just DOM work against this plan.

export interface HighlightSyncPlan {
    /** Marks that must be created: wanted, not present. */
    create: string[];
    /** Marks that already exist and only need repositioning. */
    update: string[];
    /** Marks that exist but no longer correspond to a result. */
    remove: string[];
}

export function planHighlightSync(
    existing: Iterable<string>,
    wanted: Iterable<string>,
): HighlightSyncPlan {
    const have = new Set(existing);
    const want = new Set(wanted);

    const create: string[] = [];
    const update: string[] = [];
    for (const key of want) {
        if (have.has(key)) update.push(key);
        else create.push(key);
    }

    const remove: string[] = [];
    for (const key of have) {
        if (!want.has(key)) remove.push(key);
    }

    return { create, update, remove };
}
