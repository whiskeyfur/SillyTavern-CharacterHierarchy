export const METADATA_KEY = 'world_info';
export let selected_world_info = [];
export const world_info = { charLore: [] };
export const world_info_position = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4 };
export const newWorldInfoEntryTemplate = {
    key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false,
    selective: true, selectiveLogic: 0, addMemo: false, order: 100, position: 0, disable: false,
    ignoreBudget: false, excludeRecursion: false, preventRecursion: false, probability: 100,
    useProbability: true, depth: 4, group: '', groupOverride: false, groupWeight: 100,
    scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
    automationId: '', role: 0, sticky: null, cooldown: null, delay: null, triggers: [],
};
export async function loadWorldInfo(name) {
    return globalThis.__books[name] ?? null;
}
export function setGlobalBooks(list) { selected_world_info = list; }

export function openWorldInfoEditor(worldName) {
    globalThis.__worldInfoOpened = worldName;
}

/** Stand-in for the real sorted-entry assembly: runs the extension's listener, like ST does. */
export async function getSortedEntries() {
    const payload = { globalLore: [], characterLore: [], chatLore: [], personaLore: [] };
    await globalThis.__ctx.eventSource.emit('worldinfo_entries_loaded', payload);
    return [...payload.globalLore, ...payload.characterLore].sort((a, b) => b.order - a.order);
}

/** Stand-in for the real scan: reports what fired and the text it produced. */
export async function checkWorldInfo(chat, maxContext, isDryRun) {
    globalThis.__wiScan = { chat, maxContext, isDryRun };
    const sorted = await getSortedEntries();
    // Only always-on entries fire here; a keyed one needs its key in the chat.
    const activated = new Set(sorted.filter((entry) => entry.constant));
    return {
        worldInfoBefore: 'BEFORE-TEXT',
        worldInfoAfter: 'AFTER-TEXT',
        EMEntries: [],
        WIDepthEntries: [{ depth: 4, role: 0, entries: ['DEPTH-TEXT'] }],
        ANBeforeEntries: [],
        ANAfterEntries: [],
        outletEntries: {},
        allActivatedEntries: activated,
    };
}
