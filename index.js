/*
 * Character Hierarchy — a SillyTavern extension that nests character cards under one another
 * so world info is inherited up the whole tree.
 *
 * Copyright (C) 2026 John Walker II
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of
 * the GNU Affero General Public License as published by the Free Software Foundation, either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License along with this
 * program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Character Hierarchy — nest SillyTavern character cards and inherit world info up the tree.
 *
 * Cards can be nested under one another and flagged as actors (they speak) or informational
 * (they are only lore containers). When a character speaks, this extension walks from that
 * card up to the root of its tree and feeds every ancestor's lorebooks into the world info
 * scan, on top of the speaker's own books that SillyTavern already loads.
 *
 * The injection point is the `WORLDINFO_ENTRIES_LOADED` event, which hands out the mutable
 * `characterLore` array that `getSortedEntries()` is about to consume.
 */

import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import {
    METADATA_KEY,
    getSortedEntries,
    loadWorldInfo,
    newWorldInfoEntryTemplate,
    openWorldInfoEditor,
    selected_world_info,
    world_info,
    world_info_position,
} from '../../../world-info.js';
import { getUserAvatars } from '../../../personas.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../popup.js';
import { download, getCharaFilename, getFileText } from '../../../utils.js';
import { doNavbarIconClick, entitiesFilter } from '../../../../script.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { DEFAULT_FILTER_STATE, FILTER_STATES } from '../../../filters.js';

const MODULE_NAME = 'characterHierarchy';
const LOG = '[CharacterHierarchy]';

/** The top bar drawer, alongside World Info, Extensions and the rest. */
const DRAWER_BUTTON_ID = 'character_hierarchy_drawer_button';
const DRAWER_ID = 'character_hierarchy_drawer';

/** The tri-state button added to the character list's filter row. */
const LIST_FILTER_KEY = 'characterHierarchy';
const LIST_FILTER_BUTTON_ID = 'character_hierarchy_filter';
const CHARACTER_FILTER_ROW = '#rm_characters_block .rm_tag_filter';

/** SillyTavern cycles its tri-state tags in key order: selected, excluded, then off. */
const FILTER_STATE_KEYS = Object.keys(FILTER_STATES);

const ROLE = Object.freeze({ ACTOR: 'actor', INFO: 'info' });
const SCOPE = Object.freeze({ SPEAKER: 'speaker', ALL_MEMBERS: 'allMembers' });

/**
 * What can sit on the chart. Character cards were the only kind at first, so a node used to
 * be keyed by bare avatar file name; keys are now `type:id` and the old shape is migrated.
 */
const NODE_TYPES = Object.freeze({
    CHARACTER: 'char',
    BOOK: 'book',
    PERSONA: 'persona',
});

/** @type {readonly string[]} */
const NODE_TYPE_VALUES = Object.freeze(Object.values(NODE_TYPES));

/**
 * @param {string} type One of NODE_TYPES.
 * @param {string} id Avatar file name, lorebook name, or persona avatar id.
 * @returns {string} The node key.
 */
function makeKey(type, id) {
    return `${type}:${id}`;
}

/**
 * Splits a node key. Ids may themselves contain a colon, so only the first one counts.
 * @param {string} key The node key.
 * @returns {{type: string, id: string}} Its parts.
 */
function parseKey(key) {
    const text = String(key ?? '');
    const colon = text.indexOf(':');
    const type = colon === -1 ? '' : text.slice(0, colon);

    if (!NODE_TYPE_VALUES.includes(type)) {
        // Keys written before nodes had types were bare avatar file names.
        return { type: NODE_TYPES.CHARACTER, id: text };
    }

    return { type, id: text.slice(colon + 1) };
}

const keyType = (key) => parseKey(key).type;
const keyId = (key) => parseKey(key).id;
const charKey = (avatar) => makeKey(NODE_TYPES.CHARACTER, avatar);

/** Only character cards ever speak; everything else is a container. */
const isContainerType = (type) => type !== NODE_TYPES.CHARACTER;

/** Resolved at runtime so the extension keeps working whatever the clone folder is called. */
const EXTENSION_PATH = (() => {
    try {
        const dir = new URL('.', import.meta.url).pathname;
        const match = /\/scripts\/extensions\/(.+?)\/$/.exec(dir);
        if (match) {
            return match[1];
        }
    } catch {
        // Fall through to the default below.
    }
    return 'third-party/SillyTavern-CharacterHierarchy';
})();

const DEFAULT_NODE = Object.freeze({
    parent: null,
    role: ROLE.ACTOR,
    books: [],
    includeCardText: false,
    // Remembered while the thing exists, so a node whose target is gone still has a name to
    // show rather than a bare avatar id, which for a persona is a meaningless number.
    label: '',
});

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    /** @type {Record<string, object>} avatar file name -> node */
    nodes: {},
    ancestorScope: SCOPE.SPEAKER,
    includeInfoMembers: true,
    inheritPrimaryBook: true,
    inheritAuxBooks: true,
    inheritNodeBooks: true,
    includeSelfNodeBooks: true,
    injectCardText: true,
    cardTextTemplate: '[{{name}}]\n{{description}}',
    cardTextConstant: true,
    cardTextPosition: 0,
    cardTextDepthValue: 4,
    cardTextOrder: 100,
    maxDepth: 16,
    orderPenaltyPerLevel: 0,
    listFilterState: DEFAULT_FILTER_STATE,
    focusLineage: false,
    zoom: 1,
    debug: false,
});

/** Avatars we already tried and failed to unshallow, so we stop hammering the server. */
const unshallowFailures = new Set();

let initialized = false;

// #region settings and node model

function settings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    const store = extension_settings[MODULE_NAME];

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(store, key)) {
            store[key] = structuredClone(value);
        }
    }

    if (!store.nodes || typeof store.nodes !== 'object' || Array.isArray(store.nodes)) {
        store.nodes = {};
    }

    return store;
}

function save() {
    getContext().saveSettingsDebounced();
    // The character list may be filtered on tree membership, which just changed.
    refreshCharacterListFilter();
}

/**
 * @param {string} key The node key.
 * @returns {object|null} The node, or null if it is not part of the tree.
 */
function getNode(key) {
    if (!key) {
        return null;
    }
    const node = settings().nodes[key];
    return node && typeof node === 'object' ? node : null;
}

/**
 * Returns the node for a key, creating a default one if needed.
 * @param {string} key The node key.
 * @returns {object} The node.
 */
function ensureNode(key) {
    const store = settings();
    if (!store.nodes[key] || typeof store.nodes[key] !== 'object') {
        store.nodes[key] = structuredClone(DEFAULT_NODE);
    }

    const node = store.nodes[key];

    // Only character cards can act; a lorebook or a persona is always just a container.
    if (isContainerType(keyType(key))) {
        node.role = ROLE.INFO;
    } else if (node.role !== ROLE.INFO) {
        node.role = ROLE.ACTOR;
    }
    if (typeof node.parent !== 'string' || !node.parent) {
        node.parent = null;
    }
    if (!Array.isArray(node.books)) {
        node.books = [];
    }
    node.includeCardText = Boolean(node.includeCardText);
    if (typeof node.label !== 'string') {
        node.label = '';
    }
    return node;
}

const getParent = (avatar) => getNode(avatar)?.parent || null;
const getRole = (avatar) => (getNode(avatar)?.role === ROLE.INFO ? ROLE.INFO : ROLE.ACTOR);
const isInfo = (avatar) => getRole(avatar) === ROLE.INFO;

/** @returns {string[]} The keys whose parent is the given key. */
function getChildren(parentKey) {
    const nodes = settings().nodes;
    return Object.keys(nodes).filter((key) => (getParent(key) ?? null) === (parentKey ?? null));
}

/**
 * Would pointing `child` at `parent` close a loop?
 * @param {string} child Avatar being re-parented.
 * @param {string|null} parent Candidate parent avatar.
 * @returns {boolean} True if the link is illegal.
 */
function wouldCreateCycle(child, parent) {
    if (!parent) {
        return false;
    }
    const seen = new Set();
    let current = parent;
    while (current) {
        if (current === child) {
            return true;
        }
        if (seen.has(current)) {
            return false;
        }
        seen.add(current);
        current = getParent(current);
    }
    return false;
}

/**
 * Walks up the tree from a node.
 * @param {string} key Starting node key.
 * @param {number} maxDepth How many levels to climb at most.
 * @returns {{key: string, depth: number}[]} Ancestors, nearest first.
 */
function getAncestors(key, maxDepth) {
    const chain = [];
    const seen = new Set([key]);
    let current = key;

    for (let depth = 1; depth <= maxDepth; depth++) {
        const parent = getParent(current);
        if (!parent || seen.has(parent)) {
            break;
        }
        seen.add(parent);
        chain.push({ key: parent, depth });
        current = parent;
    }

    return chain;
}

/**
 * Rewrites the pre-types shape, where a node was keyed by bare avatar file name, into typed
 * keys. Runs over both the keys and the parent links so the two stay consistent.
 * @returns {boolean} True if anything was rewritten.
 */
function migrateNodeKeys() {
    const store = settings();
    const isTyped = (key) => NODE_TYPE_VALUES.some((type) => String(key).startsWith(`${type}:`));

    if (Object.keys(store.nodes).every(isTyped)) {
        return false;
    }

    /** @type {Record<string, object>} */
    const migrated = {};

    for (const [key, node] of Object.entries(store.nodes)) {
        const newKey = isTyped(key) ? key : charKey(key);
        const parent = node?.parent;
        migrated[newKey] = {
            ...node,
            parent: parent && !isTyped(parent) ? charKey(parent) : (parent ?? null),
        };
    }

    store.nodes = migrated;
    console.log(`${LOG} migrated ${Object.keys(migrated).length} nodes to typed keys`);
    return true;
}

/**
 * Everything nested under a node, however deep.
 * @param {string} key The node key.
 * @returns {Set<string>} Descendant keys, not including the node itself.
 */
function getDescendants(key) {
    const found = new Set();
    const stack = [key];

    while (stack.length) {
        for (const child of getChildren(stack.pop())) {
            // The guard also stops a loop that normalizeNodes has not reached yet.
            if (!found.has(child)) {
                found.add(child);
                stack.push(child);
            }
        }
    }

    return found;
}

/**
 * One node's whole line: itself, everything above it, and everything below it.
 * @param {string} key The node key.
 * @returns {Set<string>} The lineage.
 */
function lineageOf(key) {
    const maxDepth = Math.max(1, Number(settings().maxDepth) || 1);
    const lineage = new Set([key, ...getDescendants(key)]);

    for (const ancestor of getAncestors(key, maxDepth)) {
        lineage.add(ancestor.key);
    }

    return lineage;
}

/**
 * Repairs anything the user or a bad import could have left behind: parents that have no node
 * of their own, and parent links that close a loop.
 * @returns {boolean} True if something was changed.
 */
function normalizeNodes() {
    const store = settings();
    let changed = migrateNodeKeys();

    for (const avatar of Object.keys(store.nodes)) {
        const before = JSON.stringify(store.nodes[avatar]);
        ensureNode(avatar);
        if (JSON.stringify(store.nodes[avatar]) !== before) {
            changed = true;
        }
    }

    // A referenced parent is part of the tree by definition, so give it a node.
    for (const avatar of Object.keys(store.nodes)) {
        const parent = getParent(avatar);
        if (parent && !Object.hasOwn(store.nodes, parent)) {
            ensureNode(parent);
            changed = true;
        }
    }

    // Keep each node's remembered name current, so it survives the thing being deleted.
    for (const key of Object.keys(store.nodes)) {
        const live = liveName(key);
        if (live && store.nodes[key].label !== live) {
            store.nodes[key].label = live;
            changed = true;
        }
    }

    // Break loops by detaching the node that closes them.
    for (const avatar of Object.keys(store.nodes)) {
        const seen = new Set([avatar]);
        let current = getParent(avatar);
        while (current) {
            if (seen.has(current)) {
                console.warn(`${LOG} breaking a parent loop at ${avatar}`);
                store.nodes[avatar].parent = null;
                changed = true;
                break;
            }
            seen.add(current);
            current = getParent(current);
        }
    }

    return changed;
}

/**
 * Re-parents a card, refusing links that would close a loop.
 * @param {string} avatar Card to move.
 * @param {string|null} parent New parent, or null to detach.
 * @returns {boolean} True if the move was applied.
 */
function setParent(avatar, parent) {
    if (!avatar) {
        return false;
    }
    const target = parent || null;

    if (target && wouldCreateCycle(avatar, target)) {
        toastr.error('That would nest a card inside itself.', 'Character Hierarchy');
        return false;
    }

    ensureNode(avatar).parent = target;
    if (target) {
        ensureNode(target);
    }
    save();
    return true;
}

/**
 * Drops a card from the tree, lifting its children up to its own parent.
 * @param {string} avatar Card to remove.
 */
function removeNode(avatar) {
    const store = settings();
    const parent = getParent(avatar);

    for (const child of getChildren(avatar)) {
        store.nodes[child].parent = parent;
    }

    delete store.nodes[avatar];
    save();
}

// #endregion

// #region character and lorebook lookups

/** @returns {Map<string, number>} Avatar file name -> index in the characters array. */
function indexByAvatar() {
    const characters = getContext().characters ?? [];
    const map = new Map();
    characters.forEach((character, index) => {
        if (character?.avatar) {
            map.set(character.avatar, index);
        }
    });
    return map;
}

/**
 * @param {string} key The node key.
 * @param {Map<string, number>} [indexes] A prebuilt avatar index, for callers in a loop.
 * @returns {string} A display name, falling back to the id for things no longer installed.
 */
function liveName(key, indexes = indexByAvatar()) {
    const { type, id } = parseKey(key);

    switch (type) {
        case NODE_TYPES.BOOK:
            // A lorebook's id is its name, so it reads properly even once the book is gone.
            return id;
        case NODE_TYPES.PERSONA:
            return personaName(id);
        default:
            return getContext().characters?.[indexes.get(id)]?.name ?? '';
    }
}

function displayName(key, indexes = indexByAvatar()) {
    const { id } = parseKey(key);

    return liveName(key, indexes)
        || getNode(key)?.label
        || getCharaFilename(null, { manualAvatarKey: id })
        || id;
}

/** @returns {Record<string, string>} Persona avatar id to name. */
function allPersonas() {
    const personas = getContext().powerUserSettings?.personas;
    return /** @type {Record<string, string>} */ (
        personas && typeof personas === 'object' ? personas : {});
}

/**
 * @param {string} id Persona avatar id.
 * @returns {string} The persona's name, or an empty string.
 */
function personaName(id) {
    return allPersonas()[id] ?? '';
}

/**
 * @param {string} id Persona avatar id.
 * @returns {{description?: string, lorebook?: string, title?: string}} Its description record.
 */
function personaRecord(id) {
    const descriptions = getContext().powerUserSettings?.persona_descriptions;
    const record = descriptions && typeof descriptions === 'object' ? descriptions[id] : null;
    return record && typeof record === 'object' ? record : {};
}

/**
 * Whether the thing a node points at still exists.
 * @param {string} key The node key.
 * @returns {boolean} True if it is installed.
 */
function nodeExists(key) {
    const { type, id } = parseKey(key);

    switch (type) {
        case NODE_TYPES.BOOK:
            return (getContext().getWorldInfoNames?.() ?? []).includes(id);
        case NODE_TYPES.PERSONA:
            return Object.hasOwn(allPersonas(), id);
        default:
            return indexByAvatar().has(id);
    }
}

/**
 * The picture to show on a node, if it has one.
 * @param {string} key The node key.
 * @returns {string|null} A thumbnail URL, or null for nodes drawn as an icon.
 */
function nodeThumbnail(key) {
    const context = getContext();
    const { type, id } = parseKey(key);

    if (type === NODE_TYPES.CHARACTER) {
        return indexByAvatar().has(id) ? context.getThumbnailUrl('avatar', id) : null;
    }
    if (type === NODE_TYPES.PERSONA) {
        return Object.hasOwn(allPersonas(), id) ? context.getThumbnailUrl('persona', id) : null;
    }
    return null;
}

/**
 * Every lorebook a node offers to the things nested under it.
 *
 * "Intrinsic" means the books the node is made of: a card's own Character Lore and linked
 * extras, the lorebook a lorebook node *is*, or the book attached to a persona. "Attached"
 * means the extra books pinned to the node inside this extension.
 *
 * @param {string} key The node key.
 * @param {{intrinsic?: boolean, attached?: boolean}} [what] Which of the two to include.
 * @returns {Promise<string[]>} Book names, deduplicated.
 */
async function nodeBooks(key, { intrinsic = true, attached = true } = {}) {
    const store = settings();
    const { type, id } = parseKey(key);
    const books = [];

    if (intrinsic) {
        switch (type) {
            case NODE_TYPES.BOOK:
                books.push(id);
                break;
            case NODE_TYPES.PERSONA:
                books.push(personaRecord(id).lorebook);
                break;
            default: {
                const index = indexByAvatar().get(id);
                if (store.inheritPrimaryBook && index !== undefined) {
                    books.push(await primaryBook(index));
                }
                if (store.inheritAuxBooks) {
                    books.push(...auxBooks(id));
                }
            }
        }
    }

    if (attached) {
        books.push(...(getNode(key)?.books ?? []));
    }

    return [...new Set(books.filter((book) => typeof book === 'string' && book))];
}

/**
 * Loads a card's full data if SillyTavern only has a stub of it.
 * @param {number|undefined} index Index in the characters array.
 * @returns {Promise<object|null>} The character, or null if it could not be loaded.
 */
async function unshallow(index) {
    const context = getContext();
    const character = context.characters?.[index];

    if (!character) {
        return null;
    }
    if (!character.shallow) {
        return character;
    }
    if (unshallowFailures.has(character.avatar)) {
        return character;
    }

    try {
        await context.unshallowCharacter(String(index));
    } catch (error) {
        console.warn(`${LOG} could not load full card data for ${character.avatar}`, error);
        unshallowFailures.add(character.avatar);
    }

    return getContext().characters?.[index] ?? character;
}

/**
 * The lorebook set on the card itself ("Character Lore").
 * @param {number|undefined} index Index in the characters array.
 * @returns {Promise<string|null>} Book name, or null.
 */
async function primaryBook(index) {
    const character = await unshallow(index);
    const book = character?.data?.extensions?.world;
    return typeof book === 'string' && book ? book : null;
}

/**
 * The extra lorebooks linked to a card through "Link to World Info".
 * @param {string} avatar Avatar file name.
 * @returns {string[]} Book names.
 */
function auxBooks(avatar) {
    const fileName = getCharaFilename(null, { manualAvatarKey: avatar });
    if (!fileName) {
        return [];
    }

    const charLore = Array.isArray(world_info?.charLore) ? world_info.charLore : [];
    const entry = charLore.find((item) => item?.name === fileName);
    const books = Array.isArray(entry?.extraBooks) ? entry.extraBooks : [];

    return books.filter((book) => typeof book === 'string' && book);
}

/** @returns {Set<string>} Books SillyTavern is already scanning without our help. */
function alreadyScannedBooks(context) {
    const books = new Set();

    for (const book of Array.isArray(selected_world_info) ? selected_world_info : []) {
        if (book) {
            books.add(book);
        }
    }

    const chatBook = context.chatMetadata?.[METADATA_KEY];
    if (chatBook) {
        books.add(chatBook);
    }

    const personaBook = context.powerUserSettings?.persona_description_lorebook;
    if (personaBook) {
        books.add(personaBook);
    }

    return books;
}

// #endregion

// #region resolution

/**
 * Works out which cards contribute lore for the current turn.
 *
 * `loadCard` distinguishes cards whose own content SillyTavern has not already put in the
 * prompt (ancestors, informational group members) from the speaker, whose card books and
 * definitions are handled by the core.
 *
 * @param {object} context SillyTavern context.
 * @param {string|null} [speakerOverride] Treat this card as the speaker instead of the selected one.
 * @returns {{plan: Map<string, {depth: number, loadCard: boolean}>, speaker: string|null}} The plan.
 */
function buildPlan(context, speakerOverride = null) {
    const store = settings();
    const maxDepth = Math.max(1, Number(store.maxDepth) || 1);

    /** @type {Map<string, {depth: number, loadCard: boolean}>} */
    const plan = new Map();

    const add = (avatar, depth, loadCard) => {
        const existing = plan.get(avatar);
        if (existing) {
            existing.depth = Math.min(existing.depth, depth);
            existing.loadCard = existing.loadCard || loadCard;
            return;
        }
        plan.set(avatar, { depth, loadCard });
    };

    // Only character cards ever speak, so the seeds are always character keys.
    const speakerAvatar = speakerOverride ?? context.characters?.[context.characterId]?.avatar ?? null;
    const speaker = speakerAvatar ? charKey(speakerAvatar) : null;

    /** @type {{key: string, loadCard: boolean}[]} */
    const roots = [];

    if (speaker) {
        roots.push({ key: speaker, loadCard: false });
    }

    const group = context.groupId
        ? context.groups?.find((candidate) => String(candidate.id) === String(context.groupId))
        : null;

    if (group) {
        for (const member of Array.isArray(group.members) ? group.members : []) {
            if (!member || member === speakerAvatar) {
                continue;
            }
            const wanted = store.ancestorScope === SCOPE.ALL_MEMBERS
                || (store.includeInfoMembers && isInfo(charKey(member)));
            if (wanted) {
                roots.push({ key: charKey(member), loadCard: true });
            }
        }
    }

    for (const root of roots) {
        add(root.key, 0, root.loadCard);
        for (const ancestor of getAncestors(root.key, maxDepth)) {
            add(ancestor.key, ancestor.depth, true);
        }
    }

    return { plan, speaker };
}

/**
 * Turns a plan into world info entries.
 * @param {object} context SillyTavern context.
 * @param {string|null} [speakerOverride] Resolve for this card instead of the selected one.
 * @returns {Promise<object>} Entries plus a human-readable trace of how they were chosen.
 */
async function resolve(context, speakerOverride = null) {
    const store = settings();
    const { plan, speaker } = buildPlan(context, speakerOverride);
    const indexes = indexByAvatar();

    const excluded = alreadyScannedBooks(context);
    const skipped = [];

    // The speaker's own card books are loaded by getCharacterLore() already.
    if (speaker) {
        const speakerAvatar = keyId(speaker);
        const speakerPrimary = await primaryBook(indexes.get(speakerAvatar));
        if (speakerPrimary) {
            excluded.add(speakerPrimary);
        }
        for (const book of auxBooks(speakerAvatar)) {
            excluded.add(book);
        }
    }

    /** @type {Map<string, {depth: number, sources: string[]}>} */
    const books = new Map();
    /** @type {{key: string, depth: number}[]} */
    const cardTextTargets = [];

    const ordered = [...plan.entries()].sort((a, b) => a[1].depth - b[1].depth);

    for (const [key, info] of ordered) {
        const node = getNode(key);
        const name = displayName(key, indexes);

        const candidates = await nodeBooks(key, {
            // At depth 0 the speaker's own books are already in SillyTavern's hands.
            intrinsic: info.loadCard,
            attached: info.depth === 0 ? store.includeSelfNodeBooks : store.inheritNodeBooks,
        });

        for (const book of candidates) {
            if (!book) {
                continue;
            }
            if (excluded.has(book)) {
                skipped.push({ book, reason: 'already scanned', source: name });
                continue;
            }
            const existing = books.get(book);
            if (existing) {
                existing.depth = Math.min(existing.depth, info.depth);
                if (!existing.sources.includes(name)) {
                    existing.sources.push(name);
                }
                continue;
            }
            books.set(book, { depth: info.depth, sources: [name] });
        }

        if (store.injectCardText && info.loadCard && node?.includeCardText && nodeExists(key)) {
            cardTextTargets.push({ key, depth: info.depth });
        }
    }

    const entries = [];
    const loadedBooks = [];
    const penalty = Math.max(0, Number(store.orderPenaltyPerLevel) || 0);

    for (const [book, info] of books) {
        const data = await loadWorldInfo(book);

        if (!data?.entries) {
            console.warn(`${LOG} lorebook "${book}" (from ${info.sources.join(', ')}) is missing or empty`);
            loadedBooks.push({ book, ...info, count: 0, missing: true });
            continue;
        }

        const bookEntries = Object.keys(data.entries).map((key) => {
            const { uid, ...rest } = data.entries[key];
            const entry = { uid, world: book, ...rest };
            if (penalty) {
                entry.order = (Number(entry.order) || 0) - info.depth * penalty;
            }
            return entry;
        });

        entries.push(...bookEntries);
        loadedBooks.push({ book, ...info, count: bookEntries.length, missing: false });
    }

    const cardTextEntries = [];

    for (const target of cardTextTargets) {
        const entry = await buildCardTextEntry(target);
        if (entry) {
            entries.push(entry);
            cardTextEntries.push({ key: target.key, depth: target.depth, length: entry.content.length });
        }
    }

    return { entries, speaker, plan, loadedBooks, cardTextEntries, skipped };
}

/**
 * Replaces `{{token}}` placeholders from a plain field map. Deliberately not
 * `substituteParams`, which would resolve card macros against the speaker rather than the
 * ancestor whose text we are injecting.
 * @param {string} template Template text.
 * @param {Record<string, string>} fields Field values.
 * @returns {string} The filled-in text.
 */
function applyTemplate(template, fields) {
    const keys = new Map(Object.keys(fields).map((key) => [key.toLowerCase(), key]));

    return String(template ?? '').replace(/{{\s*([a-zA-Z_]+)\s*}}/g, (match, token) => {
        const key = keys.get(String(token).toLowerCase());
        return key ? String(fields[key] ?? '') : match;
    });
}

/**
 * The text fields a node can lend to the template, and the name to file the entry under.
 * A lorebook node has no text of its own: it is already a lorebook.
 * @param {string} key The node key.
 * @returns {Promise<{name: string, fields: Record<string, string>}|null>} Its text, or null.
 */
async function nodeText(key) {
    const { type, id } = parseKey(key);

    if (type === NODE_TYPES.BOOK) {
        return null;
    }

    if (type === NODE_TYPES.PERSONA) {
        const name = personaName(id);
        const record = personaRecord(id);
        return {
            name: name || id,
            fields: {
                name: name ?? '',
                description: record.description ?? '',
                personality: '',
                scenario: '',
                mesExamples: '',
                creatorNotes: record.title ?? '',
            },
        };
    }

    const character = await unshallow(indexByAvatar().get(id));

    if (!character) {
        return null;
    }

    return {
        name: character.name || id,
        fields: {
            name: character.name ?? '',
            description: character.description ?? '',
            personality: character.personality ?? '',
            scenario: character.scenario ?? '',
            mesExamples: character.mes_example ?? '',
            creatorNotes: character.data?.creator_notes ?? character.creatorcomment ?? '',
        },
    };
}

/**
 * Builds a synthetic world info entry out of a node's own text.
 *
 * The entry's order and content are kept independent of tree depth so that its hash — which
 * SillyTavern uses to track sticky and cooldown timers — stays stable from turn to turn.
 *
 * @param {{key: string, depth: number}} target Node to render.
 * @returns {Promise<object|null>} The entry, or null if there is no text to inject.
 */
async function buildCardTextEntry(target) {
    const store = settings();
    const text = await nodeText(target.key);

    if (!text) {
        return null;
    }

    const content = applyTemplate(store.cardTextTemplate, text.fields).trim();

    if (!content) {
        return null;
    }

    const { type, id } = parseKey(target.key);
    const label = type === NODE_TYPES.CHARACTER
        ? (getCharaFilename(null, { manualAvatarKey: id }) || text.name)
        : `${type}/${id}`;
    const constant = Boolean(store.cardTextConstant);

    return {
        ...structuredClone(newWorldInfoEntryTemplate),
        uid: 0,
        world: `Hierarchy: ${label}`,
        comment: `${text.name} (hierarchy card text)`,
        content,
        constant,
        key: constant ? [] : [text.name].filter(Boolean),
        order: Number(store.cardTextOrder) || 100,
        position: Number(store.cardTextPosition) || 0,
        depth: Number(store.cardTextDepthValue) || 4,
    };
}

/**
 * Pushes inherited entries into the character lore that `getSortedEntries()` is assembling.
 * @param {{characterLore: object[]}} payload Event payload. Its arrays are live.
 */
async function onWorldInfoEntriesLoaded(payload) {
    if (!Array.isArray(payload?.characterLore)) {
        return;
    }

    try {
        const store = settings();

        if (!store.enabled) {
            return;
        }

        const context = getContext();
        const result = await resolve(context);

        if (result.entries.length) {
            payload.characterLore.push(...result.entries);
        }

        if (store.debug) {
            console.log(`${LOG} added ${result.entries.length} inherited entries`, {
                speaker: result.speaker ? displayName(result.speaker) : null,
                books: result.loadedBooks,
                cardText: result.cardTextEntries,
                skipped: result.skipped,
            });
        }
    } catch (error) {
        console.error(`${LOG} failed to resolve inherited world info`, error);
    }
}

// #endregion

// #region user interface

const SVG_NS = 'http://www.w3.org/2000/svg';

const NODE_WIDTH = 116;
const NODE_HEIGHT = 108;
const COLUMN_GAP = 18;
const ROW_GAP = 48;
const ROOT_GAP = 34;

/**
 * A rank of nothing but leaves is stacked down the page rather than spread across it, since
 * width is the scarce direction: three names cost 198px stacked against 384px side by side.
 * The indent clears the parent's centre line, so the connector stubs run rightwards.
 */
const STACK_INDENT = Math.round(NODE_WIDTH / 2) + 24;
const STACK_GAP = 8;

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2;
const ZOOM_STEP = 1.1;

/** Breathing room inside the chart. Pushed into CSS so the two cannot drift apart. */
const CHART_PADDING = 14;

/** How far the pointer must travel before a click becomes a drag. */
const DRAG_THRESHOLD = 4;

/** SillyTavern's own character list, which doubles as the source of new cards. */
const CHARACTER_LIST = '#rm_print_characters_block';

/** The drawer that list lives in. */
const CHARACTER_PANEL = Object.freeze({
    toggle: '#rightNavHolder .drawer-toggle',
    content: '#right-nav-panel',
    icon: '#rightNavDrawerIcon',
    lock: '#rm_button_panel_pin',
});

/** The node whose settings the panel under the chart is showing. */
let selectedKey = null;

/** Live drag state, or null when nothing is being dragged. */
let dragState = null;

function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of [].concat(children)) {
        if (child) {
            node.append(child);
        }
    }
    return node;
}

function iconButton(classes, title) {
    return el('div', { className: `menu_button ${classes}`, title });
}

/**
 * Builds a labelled control.
 * @param {string} text Label text.
 * @param {HTMLElement} control The control itself.
 * @param {string} [hint] Optional explanation below the control.
 * @returns {DocumentFragment} The group.
 */
function field(text, control, hint) {
    const fragment = document.createDocumentFragment();
    fragment.append(el('label', { textContent: text }));
    fragment.append(control);
    if (hint) {
        fragment.append(el('div', { className: 'ch-hint', textContent: hint }));
    }
    return fragment;
}

// ---------------------------------------------------------------- layout

/**
 * Lays the forest out like an org chart: children sit on the row below their parent, each
 * leaf claims the next column, and every parent is centred over the children it owns. Sibling
 * subtrees therefore occupy disjoint column ranges and cannot overlap.
 *
 * @returns {{positions: Map<string, {x: number, y: number, depth: number, stacked?: boolean}>, width: number, height: number}}
 */
/**
 * The nodes the chart should draw.
 *
 * Normally everything. With focus on, just one line: the anchor, everything above it and
 * everything below it — so other roots and the ancestors' other branches drop away.
 *
 * @returns {{keys: Set<string>|null, anchor: string|null}} Null keys means draw everything.
 */
function focusedKeys() {
    const store = settings();

    if (!store.focusLineage) {
        return { keys: null, anchor: null };
    }

    // Anchor on the selected node, or failing that on whoever is currently open.
    const context = getContext();
    const openAvatar = context.characters?.[context.characterId]?.avatar;
    const anchor = [selectedKey, openAvatar ? charKey(openAvatar) : null]
        .find((candidate) => candidate && getNode(candidate)) ?? null;

    if (!anchor) {
        return { keys: null, anchor: null };
    }

    return { keys: lineageOf(anchor), anchor };
}

function layoutForest() {
    const store = settings();
    const indexes = indexByAvatar();
    const { keys: visible } = focusedKeys();
    const byName = (a, b) => displayName(a, indexes).localeCompare(displayName(b, indexes));

    /** @type {Map<string, {x: number, y: number, depth: number, stacked?: boolean}>} */
    const positions = new Map();
    const seen = new Set();
    let column = 0;

    const rowY = (depth) => depth * (NODE_HEIGHT + ROW_GAP);

    const place = (key, depth) => {
        if (seen.has(key)) {
            return null;
        }
        seen.add(key);

        const children = getChildren(key).filter(isShown).sort(byName);

        // Nothing below this rank, so stack it instead of spreading it out.
        const stacks = children.length > 1
            && children.every((child) => getChildren(child).filter(isShown).length === 0);

        if (stacks) {
            const x = column;
            column += STACK_INDENT + NODE_WIDTH + COLUMN_GAP;
            positions.set(key, { x, y: rowY(depth), depth });

            children.forEach((child, index) => {
                seen.add(child);
                positions.set(child, {
                    x: x + STACK_INDENT,
                    y: rowY(depth) + NODE_HEIGHT + ROW_GAP + index * (NODE_HEIGHT + STACK_GAP),
                    depth: depth + 1,
                    stacked: true,
                });
            });

            return x;
        }

        const childCentres = [];
        for (const child of children) {
            const centre = place(child, depth + 1);
            if (centre !== null) {
                childCentres.push(centre);
            }
        }

        let x;
        if (childCentres.length) {
            x = (childCentres[0] + childCentres[childCentres.length - 1]) / 2;
        } else {
            x = column;
            column += NODE_WIDTH + COLUMN_GAP;
        }

        positions.set(key, { x, y: rowY(depth), depth });
        return x;
    };

    const keys = Object.keys(store.nodes).filter((key) => !visible || visible.has(key));
    const shown = new Set(keys);
    const isShown = (key) => shown.has(key);

    // A node whose parent is hidden becomes a root of what is drawn.
    for (const root of keys.filter((key) => !getParent(key) || !isShown(getParent(key))).sort(byName)) {
        place(root, 0);
        column += ROOT_GAP;
    }

    // Anything still unplaced sat in a loop normalizeNodes could not untangle. Show it anyway.
    for (const stray of keys.filter((key) => !seen.has(key)).sort(byName)) {
        place(stray, 0);
        column += ROOT_GAP;
    }

    // Measured from the boxes rather than the rank count: a stack runs past its own rank.
    let widest = 0;
    let lowest = 0;
    for (const position of positions.values()) {
        widest = Math.max(widest, position.x);
        lowest = Math.max(lowest, position.y);
    }

    return {
        positions,
        width: positions.size ? widest + NODE_WIDTH : 0,
        height: positions.size ? lowest + NODE_HEIGHT : 0,
    };
}

// ---------------------------------------------------------------- cards

/** What double-clicking a node, or its menu's open entry, actually opens. */
const OPEN_TARGETS = Object.freeze({
    [NODE_TYPES.CHARACTER]: { label: 'Open chat', icon: 'fa-comments' },
    [NODE_TYPES.PERSONA]: { label: 'Open in the persona manager', icon: 'fa-user' },
    [NODE_TYPES.BOOK]: { label: 'Open in the world info editor', icon: 'fa-book-atlas' },
});

/** Font Awesome icons standing in for the things that have no portrait. */
const NODE_ICONS = Object.freeze({
    [NODE_TYPES.BOOK]: 'fa-book-atlas',
    [NODE_TYPES.PERSONA]: 'fa-user',
    [NODE_TYPES.CHARACTER]: 'fa-user-astronaut',
});

/**
 * One node box on the chart.
 * @param {string} key The node key.
 * @param {Map<string, number>} indexes Prebuilt avatar index.
 * @returns {HTMLElement} The box.
 */
function buildCardBox(key, indexes) {
    const { type } = parseKey(key);
    const node = getNode(key);
    const missing = !nodeExists(key);
    const thumbnail = nodeThumbnail(key);

    const box = el('div', { className: `ch-node ch-node-${type}` });
    box.dataset.key = key;
    box.dataset.chDrop = 'node';

    if (missing) {
        box.classList.add('ch-node-missing');
    }
    if (node?.role === ROLE.INFO) {
        box.classList.add('ch-node-info');
    }
    if (key === selectedKey) {
        box.classList.add('ch-node-selected');
    }

    if (thumbnail) {
        box.append(el('img', { className: 'ch-node-avatar', src: thumbnail, alt: '', draggable: false }));
    } else {
        box.append(el('div', {
            className: `ch-node-avatar ch-node-icon fa-solid ${NODE_ICONS[type] ?? NODE_ICONS[NODE_TYPES.CHARACTER]}`,
        }));
    }

    box.append(el('div', {
        className: 'ch-node-name',
        textContent: displayName(key, indexes),
        title: missing ? `${key} — not installed` : key,
    }));

    if (node) {
        const meta = el('div', { className: 'ch-node-meta' });
        meta.append(el('span', {
            className: 'ch-node-role',
            textContent: type === NODE_TYPES.CHARACTER
                ? (node.role === ROLE.INFO ? 'informational' : 'actor')
                : (type === NODE_TYPES.BOOK ? 'lorebook' : 'persona'),
        }));
        if (node.books.length) {
            meta.append(el('span', {
                className: 'ch-node-books',
                textContent: node.books.length === 1 ? '1 book' : `${node.books.length} books`,
                title: node.books.join('\n'),
            }));
        }
        if (node.includeCardText) {
            meta.append(el('span', {
                className: 'ch-node-cardtext fa-solid fa-align-left',
                title: 'This node\'s own text is injected as a world info entry.',
            }));
        }
        if (missing) {
            meta.append(el('span', { className: 'ch-node-gone', textContent: 'missing' }));
        }
        box.append(meta);
    }

    attachDragHandlers(box, key);

    box.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        // Keep it off SillyTavern's own context menu handlers further up the tree.
        event.stopPropagation();
        showNodeMenu(key, event.clientX ?? 0, event.clientY ?? 0);
    });

    return box;
}

// ---------------------------------------------------------------- the node context menu

/** The open context menu, or null. */
let nodeMenu = null;

function closeNodeMenu() {
    nodeMenu?.remove();
    nodeMenu = null;
    document.removeEventListener('pointerdown', onNodeMenuDismiss, true);
    document.removeEventListener('keydown', onNodeMenuKey, true);
}

function onNodeMenuDismiss(event) {
    if (nodeMenu && event.target instanceof Node && !nodeMenu.contains(event.target)) {
        closeNodeMenu();
    }
}

function onNodeMenuKey(event) {
    if (event.key === 'Escape') {
        closeNodeMenu();
    }
}

/** Keeps the focus toggle in the panel header in step with the setting. */
function syncFocusButton() {
    document.getElementById('ch_focus')?.classList.toggle('ch-toggle-on', Boolean(settings().focusLineage));
}

/**
 * Opens the right-click menu for a node.
 * @param {string} key The node key.
 * @param {number} x Viewport x of the pointer.
 * @param {number} y Viewport y of the pointer.
 */
function showNodeMenu(key, x, y) {
    closeNodeMenu();

    const focused = Boolean(settings().focusLineage);
    const menu = el('div', { className: 'ch-context-menu' });

    const item = (icon, label, action, extraClass = '') => {
        const row = el('div', { className: `ch-context-item ${extraClass}`.trim() });
        row.append(el('i', { className: `fa-solid fa-fw ${icon}` }), el('span', { textContent: label }));
        row.addEventListener('click', () => {
            closeNodeMenu();
            action();
        });
        return row;
    };

    menu.append(el('div', { className: 'ch-context-title', textContent: displayName(key) }));

    // "Edit" alone was ambiguous: on a persona it reads as editing the persona, not as
    // selecting the node. Both actions are now named for what they actually do.
    const opens = OPEN_TARGETS[parseKey(key).type] ?? OPEN_TARGETS[NODE_TYPES.CHARACTER];
    menu.append(item(opens.icon, opens.label, () => openNodeTarget(key)));
    menu.append(item('fa-sliders', 'Settings on this chart', () => selectNode(key)));

    if (getParent(key)) {
        menu.append(item('fa-link-slash', 'Detach from parent', () => {
            setParent(key, null);
            renderAll();
        }));
    }

    menu.append(item('fa-crosshairs', focused ? 'Show the whole chart' : 'Focus on this line', () => {
        settings().focusLineage = !focused;
        getContext().saveSettingsDebounced();
        syncFocusButton();
        // Selecting re-anchors the focus on this node.
        selectNode(key);
    }));

    menu.append(item('fa-trash-can', 'Take off the chart',
        () => detachFromChart(key), 'ch-context-danger'));

    // SillyTavern closes every unpinned drawer on a mousedown that did not land inside an open
    // one, and this menu deliberately sits on the body so the chart pane cannot clip it. Keep
    // its presses to itself, or using the menu would shut the panel it belongs to.
    for (const type of ['mousedown', 'touchstart']) {
        menu.addEventListener(type, (event) => event.stopPropagation());
    }

    // On the body, so the chart pane's own scrolling cannot clip it.
    document.body.append(menu);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    // Flip it back inside the window if it would hang off an edge.
    const rect = menu.getBoundingClientRect();
    if (rect.width && rect.right > window.innerWidth) {
        menu.style.left = `${Math.max(0, x - rect.width)}px`;
    }
    if (rect.height && rect.bottom > window.innerHeight) {
        menu.style.top = `${Math.max(0, y - rect.height)}px`;
    }

    nodeMenu = menu;
    document.addEventListener('pointerdown', onNodeMenuDismiss, true);
    document.addEventListener('keydown', onNodeMenuKey, true);
}

/**
 * Takes a node off the chart, lifting its children to its old parent.
 * @param {string} key The node key.
 */
function detachFromChart(key) {
    if (!getNode(key)) {
        return;
    }

    const name = displayName(key);
    removeNode(key);

    if (selectedKey === key) {
        selectedKey = null;
    }

    renderAll();
    toastr.info(`${name} is off the chart. Its lore is no longer inherited.`, 'Character Hierarchy');
}

// ---------------------------------------------------------------- dragging

/**
 * Starts a drag on pointerdown. The pointer is deliberately not captured: the floating ghost
 * ignores pointer events, so whatever is under the cursor stays the event target and doubles
 * as the drop target.
 *
 * @param {HTMLElement} box The element being dragged.
 * @param {string} key The node key it stands for.
 * @param {'chart'|'list'} origin Where the drag began.
 */
function attachDragHandlers(box, key, origin = 'chart') {
    box.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) {
            return;
        }

        // Nothing to drop onto while the panel is shut, and every release would count as
        // "off the chart", which removes things.
        if (origin === 'list' && !isDrawerOpen()) {
            return;
        }

        // Dragging out of SillyTavern's character list must not block its own click handling,
        // so the default is only suppressed once the pointer has actually travelled.
        if (origin === 'chart') {
            event.preventDefault();
        }

        dragState = {
            key,
            origin,
            source: box,
            startX: event.clientX ?? 0,
            startY: event.clientY ?? 0,
            moved: false,
            ghost: null,
            target: null,
        };

        document.addEventListener('pointermove', onDragMove);
        document.addEventListener('pointerup', onDragEnd);
        document.addEventListener('pointercancel', onDragCancel);
    });
}

/**
 * Works out what the pointer is over, and whether dropping there would mean anything.
 * @param {Event} event A pointer event.
 * @returns {{element: HTMLElement|null, kind: string, key?: string, allowed: boolean}|null} The target.
 */
function findDropTarget(event) {
    if (!dragState) {
        return null;
    }

    const found = event.target instanceof Element ? event.target.closest('[data-ch-drop]') : null;

    if (found instanceof HTMLElement) {
        const kind = found.dataset.chDrop;

        if (kind === 'node') {
            const key = found.dataset.key;
            if (!key || key === dragState.key) {
                return null;
            }
            if (getParent(dragState.key) === key) {
                return { element: found, kind, key, allowed: false };
            }
            return { element: found, kind, key, allowed: !wouldCreateCycle(dragState.key, key) };
        }

        if (kind === 'root') {
            const node = getNode(dragState.key);
            return { element: found, kind, allowed: !node || Boolean(node.parent) };
        }
    }

    // Anywhere else is off the chart, which takes an existing node out of the tree.
    return { element: null, kind: 'remove', allowed: Boolean(getNode(dragState.key)) };
}

/**
 * @param {{element: HTMLElement|null, allowed: boolean, kind: string}|null} target The new target.
 */
function setDropTarget(target) {
    if (dragState?.target?.element && dragState.target.element !== target?.element) {
        dragState.target.element.classList.remove('ch-drop-ok', 'ch-drop-bad');
    }
    if (!dragState) {
        return;
    }

    dragState.target = target;

    if (target?.element) {
        target.element.classList.toggle('ch-drop-ok', target.allowed);
        target.element.classList.toggle('ch-drop-bad', !target.allowed);
    }

    // Make "let go here and it comes off the chart" unmistakable.
    dragState.ghost?.classList.toggle('ch-ghost-remove', target?.kind === 'remove' && target.allowed);
}

function onDragMove(event) {
    if (!dragState) {
        return;
    }

    const dx = (event.clientX ?? 0) - dragState.startX;
    const dy = (event.clientY ?? 0) - dragState.startY;

    if (!dragState.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
            return;
        }
        dragState.moved = true;
        dragState.source.classList.add('ch-node-dragging');
        releaseListPress();

        const ghost = buildCardBox(dragState.key, indexByAvatar());
        ghost.classList.add('ch-ghost');
        ghost.classList.remove('ch-node-selected');
        ghost.removeAttribute('data-ch-drop');
        document.body.append(ghost);
        dragState.ghost = ghost;
    }

    if (dragState.ghost) {
        dragState.ghost.style.left = `${event.clientX ?? 0}px`;
        dragState.ghost.style.top = `${event.clientY ?? 0}px`;
    }

    setDropTarget(findDropTarget(event));
}

function cleanupDrag() {
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', onDragEnd);
    document.removeEventListener('pointercancel', onDragCancel);

    if (dragState?.target?.element) {
        dragState.target.element.classList.remove('ch-drop-ok', 'ch-drop-bad');
    }
    dragState?.ghost?.remove();
    dragState?.source?.classList.remove('ch-node-dragging');

    const state = dragState;
    dragState = null;
    return state;
}

function onDragCancel() {
    cleanupDrag();
}

function onDragEnd(event) {
    if (!dragState) {
        return;
    }

    const target = dragState.moved ? findDropTarget(event) : null;
    const state = cleanupDrag();

    // A press that never travelled is a click. On the chart that selects the node, or on a
    // second quick click opens whatever the node stands for. In SillyTavern's character list
    // it is their click to handle, not ours.
    if (!state.moved) {
        if (state.origin === 'chart') {
            const now = Date.now();

            if (lastNodeClick.key === state.key && now - lastNodeClick.at < DOUBLE_CLICK_MS) {
                lastNodeClick = { key: null, at: 0 };
                openNodeTarget(state.key);
                return;
            }

            lastNodeClick = { key: state.key, at: now };
            selectNode(state.key);
        }
        return;
    }

    // The drag ended on something; stop the list from also treating it as a character pick.
    if (state.origin === 'list') {
        suppressNextListClick(state.source);
    }

    if (!target?.allowed) {
        return;
    }

    switch (target.kind) {
        case 'node':
            if (!setParent(state.key, target.key)) {
                return;
            }
            break;
        case 'root':
            ensureNode(state.key);
            setParent(state.key, null);
            break;
        case 'remove':
            detachFromChart(state.key);
            return;
        default:
            return;
    }

    selectedKey = state.key;
    renderAll();
    scrollNodeIntoView(state.key);
}

/**
 * Tells SillyTavern the press on a character list row is over, once our own drag has taken the
 * gesture over.
 *
 * Its bulk edit overlay arms a long-press timer on a row's mousedown and cancels it on mouseup
 * over the row or the list. Our drag ends over the chart, so neither fires and the timer runs
 * on to switch bulk edit mode on by itself. A bubbling mouseup reaches both of its cancels,
 * which is what a native drag would have done — it already listens for dragend the same way.
 */
function releaseListPress() {
    if (dragState?.origin !== 'list' || !dragState.source) {
        return;
    }

    dragState.source.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

/**
 * Swallows the click that a browser fires on the row a drag just started from, so the list
 * does not also treat the drag as a character pick.
 *
 * Scoped to that one row: a document-wide listener would be armed until *some* click happened
 * and could eat an unrelated one.
 *
 * @param {HTMLElement} row The row the drag began on.
 */
function suppressNextListClick(row) {
    const swallow = (event) => {
        event.stopPropagation();
        event.preventDefault();
    };
    row.addEventListener('click', swallow, { capture: true, once: true });
    // If no click arrives, do not leave the listener armed for the next one.
    setTimeout(() => row.removeEventListener('click', swallow, { capture: true }), 0);
}

// ---------------------------------------------------------------- SillyTavern's character list

/**
 * Makes SillyTavern's own character list the source of new cards: its rows can be dragged
 * onto the chart, and rows already on the chart are dimmed.
 */
function wireCharacterList() {
    const list = document.querySelector(CHARACTER_LIST);

    if (!list) {
        console.warn(`${LOG} no character list, so cards cannot be dragged onto the chart`);
        return;
    }

    decorateCharacterList();

    // The list is re-rendered on paging, searching and filtering, so re-decorate each time.
    new MutationObserver(() => decorateCharacterList()).observe(list, { childList: true, subtree: true });
}

/** @returns {string|null} The avatar a character list row stands for. */
function avatarOfListRow(row) {
    const chid = row?.dataset?.chid;
    if (chid === undefined) {
        return null;
    }
    return getContext().characters?.[Number(chid)]?.avatar ?? null;
}

/** Marks rows that are already on the chart, and makes every row a drag source. */
function decorateCharacterList() {
    const list = document.querySelector(CHARACTER_LIST);

    if (!list) {
        return;
    }

    const panelOpen = isDrawerOpen();

    for (const row of list.querySelectorAll('.character_select')) {
        if (!(row instanceof HTMLElement)) {
            continue;
        }

        const avatar = avatarOfListRow(row);

        if (!avatar) {
            continue;
        }

        // The dimming is an affordance of the panel. With the panel shut, SillyTavern's list
        // should look exactly as it drew it.
        row.classList.toggle('ch-on-chart', panelOpen && Boolean(getNode(charKey(avatar))));

        if (!row.dataset.chDragWired) {
            row.dataset.chDragWired = 'true';

            // A row contains the card's thumbnail, and browsers drag images natively. That
            // drag ends in a drop on the page, where SillyTavern's importer takes it for a
            // character file and reports it as corrupt. Suppress it so only our own
            // pointer-driven drag runs. dragstart bubbles, so this covers the image too.
            row.draggable = false;
            row.addEventListener('dragstart', (event) => event.preventDefault());

            attachDragHandlers(row, charKey(avatar), 'list');
        }
    }
}

// ---------------------------------------------------------------- chart

function renderChart() {
    const container = document.getElementById('ch_chart');
    if (!container) {
        return;
    }

    closeNodeMenu();
    wireChartBackground(container);

    if (normalizeNodes()) {
        save();
    }

    const indexes = indexByAvatar();
    const { positions, width, height } = layoutForest();

    container.innerHTML = '';
    container.dataset.chDrop = 'root';
    container.style.setProperty('--ch-pad', `${CHART_PADDING}px`);

    // The padding is added back on to the laid-out size; otherwise min-width/min-height of
    // 100% would always overflow the pane by it.
    const zoom = getZoom();
    const laidOutWidth = width + CHART_PADDING * 2;
    const laidOutHeight = height + CHART_PADDING * 2;

    // The chart is the canvas, sized to the tree *as drawn*, so the pane's scrollbars match
    // what is on screen. The surface inside it carries the scale, since a transform leaves the
    // layout box alone and would otherwise scroll as though nothing had been zoomed.
    container.style.width = positions.size ? `${laidOutWidth * zoom}px` : '';
    container.style.height = positions.size ? `${laidOutHeight * zoom}px` : '';

    const { anchor } = focusedKeys();
    const hidden = Object.keys(settings().nodes).length - positions.size;

    if (!positions.size) {
        container.append(el('div', {
            className: 'ch-empty',
            textContent: 'Drag a character here from the list on the right, or add a lorebook or persona above.',
        }));
        return;
    }

    const surface = el('div', { className: 'ch-chart-surface' });
    surface.style.width = `${laidOutWidth}px`;
    surface.style.height = `${laidOutHeight}px`;
    surface.style.transform = `scale(${zoom})`;
    container.append(surface);

    // Connectors go in first so the boxes sit on top of them.
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ch-links');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    for (const [key, position] of positions) {
        const parent = getParent(key);
        const parentPosition = parent ? positions.get(parent) : null;
        if (!parentPosition) {
            continue;
        }

        const fromX = parentPosition.x + NODE_WIDTH / 2;
        const fromY = parentPosition.y + NODE_HEIGHT;

        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('class', 'ch-link');

        if (position.stacked) {
            // Down the parent's centre line, then a stub into the child's left edge.
            const midY = position.y + NODE_HEIGHT / 2;
            path.setAttribute('d', `M ${fromX} ${fromY} V ${midY} H ${position.x}`);
        } else {
            const toX = position.x + NODE_WIDTH / 2;
            path.setAttribute('d', `M ${fromX} ${fromY} V ${fromY + ROW_GAP / 2} H ${toX} V ${position.y}`);
        }

        svg.append(path);
    }

    surface.append(svg);

    for (const [key, position] of positions) {
        const box = buildCardBox(key, indexes);
        box.style.left = `${position.x}px`;
        box.style.top = `${position.y}px`;
        surface.append(box);
    }

    renderNodeActions(surface, positions);

    if (anchor && hidden > 0) {
        surface.append(el('div', {
            className: 'ch-focus-note',
            textContent: `Showing only ${displayName(anchor)}'s line — ${hidden} other `
                + `${hidden === 1 ? 'node is' : 'nodes are'} hidden.`,
        }));
    }
}

/**
 * The little strip of actions that appears directly under the selected node.
 * @param {HTMLElement} container The chart.
 * @param {Map<string, {x: number, y: number}>} positions Laid-out node positions.
 */
function renderNodeActions(container, positions) {
    const position = selectedKey ? positions.get(selectedKey) : null;

    if (!position) {
        return;
    }

    const actions = el('div', { className: 'ch-node-actions' });
    actions.style.left = `${position.x}px`;
    actions.style.top = `${position.y + NODE_HEIGHT}px`;

    const focused = Boolean(settings().focusLineage);
    const focus = el('div', {
        className: `ch-node-action fa-solid fa-crosshairs${focused ? ' ch-toggle-on' : ''}`,
        title: focused ? 'Show the whole chart again' : 'Show only this node\'s line',
    });
    focus.addEventListener('click', () => {
        settings().focusLineage = !focused;
        getContext().saveSettingsDebounced();
        syncFocusButton();
        // Re-selecting re-anchors the focus on this node and repaints.
        selectNode(selectedKey);
    });
    actions.append(focus);

    if (getParent(selectedKey)) {
        const detach = el('div', {
            className: 'ch-node-action fa-solid fa-link-slash',
            title: 'Detach from its parent, leaving it a root',
        });
        detach.addEventListener('click', () => {
            setParent(selectedKey, null);
            renderAll();
        });
        actions.append(detach);
    }

    const remove = el('div', {
        className: 'ch-node-action ch-node-action-remove fa-solid fa-trash-can',
        title: 'Take this off the chart',
    });
    remove.addEventListener('click', () => detachFromChart(selectedKey));
    actions.append(remove);

    container.append(actions);
}

/** Where a press on empty chart space began, so a click can be told from a drag. */
let backgroundPress = null;

/** A pan in progress on the chart's backdrop, or null. */
let chartPan = null;

/** @returns {number} The stored zoom, clamped to what the chart will actually draw at. */
function getZoom() {
    const zoom = Number(settings().zoom);
    return Number.isFinite(zoom) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) : 1;
}

/**
 * Zooms the chart about a point, so whatever is under the cursor stays under it.
 * @param {number} next The new zoom.
 * @param {number} [clientX] Viewport x to keep fixed.
 * @param {number} [clientY] Viewport y to keep fixed.
 */
function setZoom(next, clientX, clientY) {
    const pane = document.querySelector('.ch-chart-pane');
    const before = getZoom();
    const after = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));

    if (!pane || after === before) {
        return;
    }

    // Where the cursor is over the chart's own coordinates, before the scale changes.
    const box = pane.getBoundingClientRect();
    const anchorX = (clientX ?? box.left + box.width / 2) - box.left + pane.scrollLeft;
    const anchorY = (clientY ?? box.top + box.height / 2) - box.top + pane.scrollTop;

    settings().zoom = after;
    getContext().saveSettingsDebounced();
    renderChart();

    const ratio = after / before;
    pane.scrollLeft += anchorX * ratio - anchorX;
    pane.scrollTop += anchorY * ratio - anchorY;
    syncZoomButton();
}

/** Shows the current zoom on the header button, so it is obvious when it is not 100%. */
function syncZoomButton() {
    const button = document.getElementById('ch_zoom_reset');
    if (!button) {
        return;
    }
    const zoom = getZoom();
    button.classList.toggle('ch-toggle-on', zoom !== 1);
    button.title = `Zoom: ${Math.round(zoom * 100)}% — click to reset. Scroll the chart to zoom.`;
}

/**
 * Scrolls a node into view, for when it has just been added or picked out and is off screen.
 * @param {string} key The node key.
 */
function scrollNodeIntoView(key) {
    // Matched by hand rather than by selector: a node key carries a colon and a file name,
    // neither of which belongs in one unescaped.
    const node = [...document.querySelectorAll('#ch_chart .ch-node')]
        .find((box) => box instanceof HTMLElement && box.dataset.key === key);

    try {
        node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
        // Purely a convenience; not worth failing a render over.
    }
}

/**
 * Drags the chart under the cursor. The pane is what actually scrolls, so panning is just
 * moving its scroll offset against the pointer.
 */
function onChartPan(event) {
    if (!chartPan) {
        return;
    }

    const x = event.clientX ?? 0;
    const y = event.clientY ?? 0;
    const dx = x - chartPan.x;
    const dy = y - chartPan.y;

    // Below the threshold this is still a click, which clears the selection on release.
    if (!chartPan.panning && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
        return;
    }

    if (!chartPan.panning) {
        chartPan.panning = true;
        chartPan.pane.classList.add('ch-panning');
    }

    chartPan.pane.scrollLeft -= dx;
    chartPan.pane.scrollTop -= dy;
    chartPan.x = x;
    chartPan.y = y;
}

function onChartPanEnd() {
    if (!chartPan) {
        return;
    }

    chartPan.pane.classList.remove('ch-panning');
    document.removeEventListener('pointermove', onChartPan);
    document.removeEventListener('pointerup', onChartPanEnd);
    document.removeEventListener('pointercancel', onChartPanEnd);
    chartPan = null;
}

/** How close together two clicks on a node count as a double click. */
const DOUBLE_CLICK_MS = 400;

/** The last node click, for spotting the second one. */
let lastNodeClick = { key: null, at: 0 };

/**
 * Opens whatever a node stands for: a character's chat, a persona in the persona manager, or
 * a lorebook in the world info editor.
 *
 * Double click is detected from our own pointer handling rather than the native dblclick
 * event, which a chart node never sees — pointerdown is defaulted away there to stop the
 * browser starting a drag or a selection of its own.
 *
 * @param {string} key The node key.
 */
async function openNodeTarget(key) {
    const { type, id } = parseKey(key);

    if (!nodeExists(key)) {
        toastr.warning(`${displayName(key)} is not installed any more.`, 'Character Hierarchy');
        return;
    }

    try {
        switch (type) {
            case NODE_TYPES.BOOK:
                openWorldInfoEditor(id);
                break;

            case NODE_TYPES.PERSONA: {
                const toggle = document.querySelector('#persona-management-button .drawer-toggle');
                if (toggle instanceof HTMLElement
                    && !document.querySelector('#persona-management-button .drawer-content')
                        ?.classList.contains('openDrawer')) {
                    toggle.click();
                }
                // Pages the persona list to the one asked for, the way SillyTavern does.
                await getUserAvatars(true, id);
                break;
            }

            default: {
                const index = indexByAvatar().get(id);
                if (index !== undefined) {
                    await getContext().selectCharacterById(index);
                }
            }
        }
    } catch (error) {
        console.error(`${LOG} could not open ${key}`, error);
        toastr.error(`Could not open ${displayName(key)}.`, 'Character Hierarchy');
    }
}

/**
 * Clicking empty chart space clears the selection. Both the press and the release have to land
 * on the background itself, so a drag that started on a node and ended on the backdrop is left
 * alone — that one has just re-rooted the node and selected it.
 *
 * @param {HTMLElement} container The chart.
 */
function wireChartBackground(container) {
    if (container.dataset.chBackgroundWired) {
        return;
    }
    container.dataset.chBackgroundWired = 'true';

    const isBackdrop = (target) => target === container
        || (target instanceof Element && target.classList.contains('ch-chart-surface'));

    container.addEventListener('pointerdown', (event) => {
        if (!isBackdrop(event.target) || (event.button !== undefined && event.button !== 0)) {
            backgroundPress = null;
            return;
        }

        backgroundPress = { x: event.clientX ?? 0, y: event.clientY ?? 0 };

        // Touch already scrolls the pane on its own; panning as well would move it twice.
        if (event.pointerType === 'touch') {
            return;
        }

        const pane = container.parentElement;
        if (!pane) {
            return;
        }

        // Stops the browser starting a selection drag from the backdrop instead.
        event.preventDefault();

        chartPan = { pane, x: event.clientX ?? 0, y: event.clientY ?? 0, panning: false };
        document.addEventListener('pointermove', onChartPan);
        document.addEventListener('pointerup', onChartPanEnd);
        document.addEventListener('pointercancel', onChartPanEnd);
    });

    container.addEventListener('wheel', (event) => {
        event.preventDefault();
        const direction = (event.deltaY ?? 0) > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
        setZoom(getZoom() * direction, event.clientX, event.clientY);
    }, { passive: false });

    container.addEventListener('pointerup', (event) => {
        const press = backgroundPress;
        backgroundPress = null;

        if (!press || !isBackdrop(event.target) || !selectedKey) {
            return;
        }

        const travelled = Math.hypot((event.clientX ?? 0) - press.x, (event.clientY ?? 0) - press.y);
        if (travelled < DRAG_THRESHOLD) {
            selectNode(null);
        }
    });
}

/**
 * @param {string|null} key The node to show settings for.
 */
function selectNode(key) {
    selectedKey = key;
    renderChart();
    renderEditor();
}

function renderAll() {
    if (selectedKey && !getNode(selectedKey)) {
        selectedKey = null;
    }

    updateCharacterButton();
    decorateCharacterList();
    syncPanelInset();

    // No point laying out a chart nobody can see; opening the panel repaints it.
    if (!isDrawerOpen()) {
        return;
    }

    renderChart();
    renderEditor();
}

// ---------------------------------------------------------------- inheritance read-outs

/**
 * The books this node picks up from the nodes above it, nearest first.
 * @param {string} key The node key.
 * @returns {Promise<{book: string, depth: number, source: string}[]>} Inherited books.
 */
async function booksInheritedFromAbove(key) {
    const maxDepth = Math.max(1, Number(settings().maxDepth) || 1);
    const indexes = indexByAvatar();
    const seen = new Set();
    const inherited = [];

    for (const ancestor of getAncestors(key, maxDepth)) {
        for (const book of await nodeBooks(ancestor.key)) {
            if (seen.has(book)) {
                continue;
            }
            seen.add(book);
            inherited.push({
                book,
                depth: ancestor.depth,
                source: displayName(ancestor.key, indexes),
            });
        }
    }

    return inherited;
}

// ---------------------------------------------------------------- the node editor

/**
 * Builds the live settings panel for one node. Every control applies immediately.
 * @param {string} key The node key.
 * @param {() => void} onStructureChange Called when the node's place in the tree changes.
 * @returns {HTMLElement} The panel.
 */
function buildCardEditor(key, onStructureChange) {
    const context = getContext();
    const indexes = indexByAvatar();
    const node = ensureNode(key);
    const store = settings();
    const { type } = parseKey(key);
    const installed = nodeExists(key);
    const thumbnail = nodeThumbnail(key);

    const panel = el('div', { className: 'ch-editor' });

    const header = el('div', { className: 'ch-editor-header' });
    header.append(thumbnail
        ? el('img', { className: 'ch-editor-avatar', src: thumbnail, alt: '', draggable: false })
        : el('div', { className: `ch-editor-avatar ch-node-icon fa-solid ${NODE_ICONS[type]}` }));
    header.append(el('div', { className: 'ch-editor-title' }, [
        el('div', { className: 'ch-editor-name', textContent: displayName(key, indexes) }),
        el('div', { className: 'ch-editor-file', textContent: installed ? key : `${key} — not installed` }),
    ]));

    const remove = iconButton('fa-solid fa-trash-can', 'Take this off the chart');
    remove.addEventListener('click', () => detachFromChart(key));
    header.append(remove);
    panel.append(header);

    const grid = el('div', { className: 'ch-editor-grid' });

    // Only character cards can speak, so only they get a role to choose.
    if (type === NODE_TYPES.CHARACTER) {
        const roleSelect = el('select', { className: 'text_pole' });
        roleSelect.append(el('option', { value: ROLE.ACTOR, textContent: 'Actor — takes part in the roleplay' }));
        roleSelect.append(el('option', { value: ROLE.INFO, textContent: 'Informational — a lore container only' }));
        roleSelect.value = node.role;
        roleSelect.addEventListener('change', () => {
            ensureNode(key).role = roleSelect.value === ROLE.INFO ? ROLE.INFO : ROLE.ACTOR;
            save();
            renderChart();
            updateCharacterButton();
        });
        grid.append(el('div', {}, [field('Role', roleSelect)]));
    } else {
        grid.append(el('div', {}, [field('Role', el('input', {
            className: 'text_pole',
            value: type === NODE_TYPES.BOOK ? 'Lorebook — a container only' : 'Persona — a container only',
            disabled: true,
        }))]));
    }

    const parentSelect = el('select', { className: 'text_pole' });
    parentSelect.append(el('option', { value: '', textContent: '— none (top of its tree) —' }));

    const candidates = Object.keys(store.nodes)
        .filter((candidate) => candidate !== key && !wouldCreateCycle(key, candidate))
        .sort((a, b) => displayName(a, indexes).localeCompare(displayName(b, indexes)));

    for (const candidate of candidates) {
        parentSelect.append(el('option', {
            value: candidate,
            textContent: `${displayName(candidate, indexes)} (${parseKey(candidate).type})`,
        }));
    }
    if (node.parent && !candidates.includes(node.parent)) {
        parentSelect.append(el('option', { value: node.parent, textContent: `${node.parent} (not installed)` }));
    }
    parentSelect.value = node.parent ?? '';
    parentSelect.addEventListener('change', () => {
        if (setParent(key, parentSelect.value || null)) {
            onStructureChange();
        }
    });
    grid.append(el('div', {}, [field('Nested under', parentSelect,
        'Only things already on the chart can be parents. Or just drag the node onto its new parent.')]));
    panel.append(grid);

    const filterInput = el('input', { type: 'search', className: 'text_pole', placeholder: 'Filter lorebooks…' });
    const booksSelect = el('select', { className: 'text_pole ch-books-select', multiple: true });

    const worldNames = typeof context.getWorldInfoNames === 'function' ? context.getWorldInfoNames() : [];
    for (const name of worldNames) {
        booksSelect.append(el('option', { value: name, textContent: name, selected: node.books.includes(name) }));
    }
    for (const name of node.books.filter((book) => !worldNames.includes(book))) {
        booksSelect.append(el('option', { value: name, textContent: `${name} (missing)`, selected: true }));
    }

    filterInput.addEventListener('input', () => {
        const needle = filterInput.value.trim().toLowerCase();
        for (const option of booksSelect.options) {
            option.hidden = Boolean(needle) && !option.value.toLowerCase().includes(needle) && !option.selected;
        }
    });

    const passedDown = el('div', { className: 'ch-hint' });
    const inheritedList = el('div', { className: 'ch-inherited' });

    const refreshReadouts = async () => {
        const own = await nodeBooks(key);
        passedDown.textContent = own.length
            ? `Everything nested under this inherits: ${own.join(', ')}`
            : 'This node has no lorebooks to pass down yet.';

        inheritedList.innerHTML = '';
        const inherited = await booksInheritedFromAbove(key);
        if (!inherited.length) {
            inheritedList.append(el('div', {
                className: 'ch-hint',
                textContent: 'Nothing sits above this, so it inherits nothing.',
            }));
            return;
        }
        for (const item of inherited) {
            inheritedList.append(el('div', { className: 'ch-inherited-row' }, [
                el('span', { className: 'ch-inherited-book', textContent: item.book }),
                el('span', { className: 'ch-inherited-from', textContent: `level ${item.depth} · ${item.source}` }),
            ]));
        }
    };

    booksSelect.addEventListener('change', () => {
        ensureNode(key).books = [...booksSelect.selectedOptions].map((option) => option.value);
        save();
        renderChart();
        refreshReadouts();
    });

    panel.append(field('Extra lorebooks held on this node', filterInput,
        'Tracked by this extension, on top of whatever the node already carries. Ctrl-click or shift-click to pick several.'));
    panel.append(booksSelect);
    panel.append(passedDown);

    // A lorebook has no prose of its own to inject; a card and a persona do.
    if (type !== NODE_TYPES.BOOK) {
        const cardTextLabel = el('label', { className: 'checkbox_label' });
        const cardTextCheckbox = el('input', { type: 'checkbox', checked: node.includeCardText });
        cardTextLabel.append(cardTextCheckbox, el('span', {
            textContent: type === NODE_TYPES.PERSONA
                ? 'Inject this persona\'s description as a world info entry'
                : 'Inject this card\'s own text as a world info entry',
        }));
        cardTextCheckbox.addEventListener('change', () => {
            ensureNode(key).includeCardText = cardTextCheckbox.checked;
            save();
            renderChart();
        });
        panel.append(cardTextLabel);
        panel.append(el('div', {
            className: 'ch-hint',
            textContent: store.injectCardText
                ? 'Uses the template in the "Informational card text" section below.'
                : 'Card text injection is switched off globally, so this will have no effect yet.',
        }));
    }

    panel.append(el('div', { className: 'ch-editor-subhead', textContent: 'Inherited from above' }));
    panel.append(inheritedList);

    refreshReadouts();

    return panel;
}

function renderEditor() {
    const container = document.getElementById('ch_editor');
    if (!container) {
        return;
    }

    container.innerHTML = '';

    if (!selectedKey) {
        container.append(el('div', {
            className: 'ch-hint',
            textContent: 'Click a node in the chart to edit it.',
        }));
        return;
    }

    container.append(buildCardEditor(selectedKey, renderAll));
}

// ---------------------------------------------------------------- adding lorebooks and personas

/**
 * Asks which lorebook or persona to put on the chart, then puts it there.
 * @param {string} type NODE_TYPES.BOOK or NODE_TYPES.PERSONA.
 */
async function addNodeOfType(type) {
    const context = getContext();
    const isBook = type === NODE_TYPES.BOOK;

    const available = isBook
        ? (context.getWorldInfoNames?.() ?? []).map((name) => ({ id: name, label: name }))
        : Object.entries(allPersonas()).map(([id, name]) => ({ id, label: name || id }));

    const candidates = available
        .filter((candidate) => !getNode(makeKey(type, candidate.id)))
        .sort((a, b) => a.label.localeCompare(b.label));

    if (!candidates.length) {
        toastr.info(
            available.length
                ? `Every ${isBook ? 'lorebook' : 'persona'} is already on the chart.`
                : `There are no ${isBook ? 'lorebooks' : 'personas'} to add.`,
            'Character Hierarchy');
        return;
    }

    const content = el('div', { className: 'ch-editor' });
    content.append(el('h3', { textContent: isBook ? 'Add a lorebook' : 'Add a persona' }));

    const filterInput = el('input', { type: 'search', className: 'text_pole', placeholder: 'Filter…' });
    const select = el('select', { className: 'text_pole ch-books-select', size: 12 });

    for (const candidate of candidates) {
        select.append(el('option', { value: candidate.id, textContent: candidate.label }));
    }
    select.selectedIndex = 0;

    filterInput.addEventListener('input', () => {
        const needle = filterInput.value.trim().toLowerCase();
        for (const option of select.options) {
            option.hidden = Boolean(needle) && !option.textContent.toLowerCase().includes(needle);
        }
    });

    content.append(filterInput, select);

    const popup = new Popup(content, POPUP_TYPE.TEXT, '', { okButton: 'Add', cancelButton: 'Cancel' });

    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE || !select.value) {
        return;
    }

    const key = makeKey(type, select.value);
    ensureNode(key);
    save();
    selectedKey = key;
    renderAll();
    scrollNodeIntoView(key);
}

// ---------------------------------------------------------------- character list filter

/** @returns {string} The stored tri-state, falling back to "off". */
function getListFilterState() {
    const state = settings().listFilterState;
    return FILTER_STATE_KEYS.includes(state) ? state : DEFAULT_FILTER_STATE;
}

/**
 * Registers a filter on the character list that knows about the hierarchy, so the tri-state
 * button can show only the cards in a tree, or hide them.
 */
function installCharacterListFilter() {
    const isInHierarchy = (entity) => entity?.type === 'character'
        && Boolean(getNode(charKey(entity.item?.avatar)));

    entitiesFilter.filterData[LIST_FILTER_KEY] = getListFilterState();
    entitiesFilter.filterFunctions[LIST_FILTER_KEY] = (data) => entitiesFilter.filterDataByState(
        data,
        entitiesFilter.filterData[LIST_FILTER_KEY],
        isInHierarchy,
        { includeFolders: true },
    );
}

/**
 * Repaints the character list when the tree changes underneath an active filter.
 *
 * setFilterData() short-circuits when the value has not changed, and here it has not — the
 * membership behind it has — so the list is asked to redraw directly.
 */
function refreshCharacterListFilter() {
    if (getListFilterState() === DEFAULT_FILTER_STATE) {
        return;
    }
    entitiesFilter.onDataChanged?.();
}

/**
 * @param {HTMLElement} button The filter button.
 * @param {string} state One of FILTER_STATE_KEYS.
 */
function paintFilterButton(button, state) {
    button.dataset.toggleState = state;
    for (const key of FILTER_STATE_KEYS) {
        button.classList.toggle(FILTER_STATES[key].class, key === state);
    }
}

/** @returns {HTMLElement} A tri-state button shaped like SillyTavern's own filter tags. */
function buildFilterButton() {
    const button = el('span', { className: 'tag actionable', id: LIST_FILTER_BUTTON_ID });

    const label = el('span', { className: 'tag_name fa-solid fa-sitemap' });
    label.title = 'Show only cards in a hierarchy\n\nClick to cycle: any → only → exclude';
    button.append(label);

    paintFilterButton(button, getListFilterState());

    button.addEventListener('click', () => {
        const next = FILTER_STATE_KEYS[(FILTER_STATE_KEYS.indexOf(getListFilterState()) + 1) % FILTER_STATE_KEYS.length];
        settings().listFilterState = next;
        getContext().saveSettingsDebounced();
        paintFilterButton(button, next);
        entitiesFilter.setFilterData(LIST_FILTER_KEY, next);
    });

    return button;
}

/** Puts the button in the filter row, beside the favourites and groups toggles. */
function mountFilterButton() {
    const row = document.querySelector(CHARACTER_FILTER_ROW);

    if (!row || row.querySelector(`#${LIST_FILTER_BUTTON_ID}`)) {
        return;
    }

    const button = buildFilterButton();

    // Sit with the other "kind of entity" filters, ahead of the tag management buttons.
    const manageTags = row.querySelector('.manageTags');
    if (manageTags) {
        manageTags.before(button);
    } else {
        row.append(button);
    }
}

/** printTagFilters() empties and refills the row, so the button has to be put back. */
function watchFilterRow() {
    const row = document.querySelector(CHARACTER_FILTER_ROW);

    if (!row) {
        console.warn(`${LOG} no character list filter row, skipping the hierarchy filter`);
        return;
    }

    mountFilterButton();
    new MutationObserver(() => mountFilterButton()).observe(row, { childList: true });
}

// ---------------------------------------------------------------- the top bar drawer

/**
 * What we changed to keep the character list on screen, so it can be put back exactly.
 * @type {{opened: boolean, pinnedContent: boolean, pinnedIcon: boolean}|null}
 */
let listHold = null;

/**
 * Keeps the panel clear of SillyTavern's character list rather than running underneath it.
 *
 * The list is pinned to the right edge, so narrowing a centred panel never gets out of its
 * way — the right edge has to be pulled in by however wide the list actually is. Measured
 * rather than recomputed from SillyTavern's own formula, so a panel the user has resized is
 * still accounted for.
 */
function syncPanelInset() {
    const panel = document.getElementById(DRAWER_ID);

    if (!panel) {
        return;
    }

    const list = document.querySelector(CHARACTER_PANEL.content);
    const beside = isCharacterListOpen() && list instanceof HTMLElement;
    const width = beside ? Math.round(list.getBoundingClientRect().width) : 0;

    panel.classList.toggle('ch-beside-list', beside && width > 0);
    panel.style.setProperty('--ch-list-width', `${width}px`);
}

/** @returns {boolean} True when SillyTavern's character list is on screen. */
function isCharacterListOpen() {
    return Boolean(document.querySelector(CHARACTER_PANEL.content)?.classList.contains('openDrawer'));
}

/**
 * Brings the character list up alongside the chart, since the chart asks you to drag cards out
 * of it. Drawers close one another, so it is also pinned for the moment — exactly the way
 * SillyTavern's own pin does it — or opening our panel would shut it again.
 */
async function holdCharacterListOpen() {
    const context = getContext();
    const content = document.querySelector(CHARACTER_PANEL.content);
    const toggle = document.querySelector(CHARACTER_PANEL.toggle);

    // Two side-by-side panels do not fit a phone, so leave the choice to the user there.
    if (!content || !toggle || listHold || context.isMobile?.()) {
        return;
    }

    const opened = !isCharacterListOpen();
    if (opened) {
        await doNavbarIconClick.call($(toggle));
    }

    const icon = document.querySelector(CHARACTER_PANEL.icon);
    const pinnedContent = !content.classList.contains('pinnedOpen');
    const pinnedIcon = Boolean(icon) && !icon.classList.contains('drawerPinnedOpen');

    if (pinnedContent) {
        content.classList.add('pinnedOpen');
    }
    if (pinnedIcon) {
        icon.classList.add('drawerPinnedOpen');
    }

    listHold = { opened, pinnedContent, pinnedIcon };
}

/** @returns {boolean} True when the user has locked the character list open. */
function isCharacterListLocked() {
    const lock = document.querySelector(CHARACTER_PANEL.lock);
    return lock instanceof HTMLInputElement && lock.checked;
}

/** Undoes exactly what holdCharacterListOpen() did, and nothing the user did themselves. */
async function releaseCharacterList() {
    if (!listHold) {
        return;
    }

    const hold = listHold;
    listHold = null;

    // The hold was recorded when the panel opened. If the user has thrown the lock since,
    // that is a newer decision than ours, so leave the panel exactly as they set it.
    if (isCharacterListLocked()) {
        return;
    }

    if (hold.pinnedContent) {
        document.querySelector(CHARACTER_PANEL.content)?.classList.remove('pinnedOpen');
    }
    if (hold.pinnedIcon) {
        document.querySelector(CHARACTER_PANEL.icon)?.classList.remove('drawerPinnedOpen');
    }

    // Only shut it again if we were the ones who opened it.
    const toggle = document.querySelector(CHARACTER_PANEL.toggle);
    if (hold.opened && toggle && isCharacterListOpen()) {
        await doNavbarIconClick.call($(toggle));
    }
}

/** @returns {boolean} True when the hierarchy panel is on screen. */
function isDrawerOpen() {
    return Boolean(document.getElementById(DRAWER_ID)?.classList.contains('openDrawer'));
}

/** Opens the hierarchy panel if it is not already open. */
function openDrawer() {
    if (isDrawerOpen()) {
        return;
    }
    const toggle = document.querySelector(`#${DRAWER_BUTTON_ID} .drawer-toggle`);
    if (toggle instanceof HTMLElement) {
        toggle.click();
    }
}

/**
 * Opens the panel with one card already selected.
 * @param {string} avatar Avatar file name.
 */
function openDrawerFor(avatar) {
    selectedKey = charKey(avatar);
    openDrawer();
    renderAll();
}

/**
 * Adds the hierarchy drawer to the top bar and fills it with the panel template.
 * @returns {Promise<boolean>} True if the drawer is in place.
 */
async function installDrawer() {
    const holder = document.getElementById('top-settings-holder');

    if (!holder) {
        console.error(`${LOG} no #top-settings-holder, cannot add the hierarchy panel`);
        return false;
    }
    if (document.getElementById(DRAWER_BUTTON_ID)) {
        return true;
    }

    const drawer = el('div', { className: 'drawer', id: DRAWER_BUTTON_ID });

    const toggle = el('div', { className: 'drawer-toggle drawer-header' });
    toggle.append(el('div', {
        className: 'drawer-icon fa-solid fa-sitemap fa-fw closedIcon',
        title: 'Character Hierarchy',
    }));
    drawer.append(toggle);

    const content = el('div', { className: 'drawer-content closedDrawer ch-drawer', id: DRAWER_ID });

    // dragElement() looks for a grabber whose id is the panel's id plus "header".
    content.append(el('div', {
        className: 'fa-solid fa-grip drag-grabber',
        id: `${DRAWER_ID}header`,
    }));

    const inner = el('div', { className: 'ch-drawer-inner' });
    inner.innerHTML = await renderExtensionTemplateAsync(EXTENSION_PATH, 'drawer');
    content.append(inner);
    drawer.append(content);

    // Sit next to World Info, which is the closest neighbour in purpose.
    const worldInfo = document.getElementById('WI-SP-button');
    if (worldInfo) {
        worldInfo.after(drawer);
    } else {
        holder.append(drawer);
    }

    // SillyTavern binds the navbar handler once at startup, so this drawer needs it by hand.
    toggle.addEventListener('click', async () => {
        const opening = !isDrawerOpen();

        if (opening) {
            await holdCharacterListOpen();
        }

        await doNavbarIconClick.call($(toggle));

        if (!opening) {
            await releaseCharacterList();
        }

        // Catches the chart up on the way in, and clears the list dimming on the way out.
        renderAll();
    });

    // Opening any other drawer closes ours by swapping these classes, without ever going
    // through the handler above. Watching the classes themselves catches every route in and
    // out — another drawer, a pin, anything programmatic — rather than just the ones we can
    // guess at from clicks.
    // The list can be opened or closed on its own while the chart is up, which changes how
    // much room the chart has.
    const listPanel = document.querySelector(CHARACTER_PANEL.content);
    if (listPanel) {
        new MutationObserver(() => syncPanelInset())
            .observe(listPanel, { attributes: true, attributeFilter: ['class'] });
    }

    let wasOpen = isDrawerOpen();
    new MutationObserver(() => {
        const open = isDrawerOpen();

        if (open === wasOpen) {
            return;
        }
        wasOpen = open;

        if (!open) {
            releaseCharacterList();
        }

        // Paints the chart on the way in, and clears the character list dimming on the way out.
        renderAll();
    }).observe(content, { attributes: true, attributeFilter: ['class'] });

    const context = getContext();
    if (context.powerUserSettings?.movingUI && !context.isMobile?.()) {
        try {
            dragElement($(content));
        } catch (error) {
            console.warn(`${LOG} could not make the panel draggable`, error);
        }
    }

    return true;
}

// ---------------------------------------------------------------- panel chrome

/** Human names for world info's insertion positions. */
const POSITION_LABELS = Object.freeze({
    [world_info_position.before]: 'before char defs',
    [world_info_position.after]: 'after char defs',
    [world_info_position.ANTop]: 'AN top',
    [world_info_position.ANBottom]: 'AN bottom',
    [world_info_position.atDepth]: 'at depth',
    [world_info_position.EMTop]: 'examples top',
    [world_info_position.EMBottom]: 'examples bottom',
    [world_info_position.outlet]: 'outlet',
});

/** @returns {string} A short label for what an entry is called. */
function entryLabel(entry) {
    const keys = Array.isArray(entry.key) ? entry.key.filter(Boolean) : [];
    return entry.comment || keys.slice(0, 3).join(', ') || `uid ${entry.uid}`;
}

/**
 * Asks SillyTavern to assemble the world info it would inject right now.
 *
 * This is the same dry run the app performs before a generation: timed effects are left alone
 * and no event is emitted, so looking costs nothing.
 *
 * @param {object} context SillyTavern context.
 * @returns {Promise<object|null>} The assembled prompt pieces, or null if it could not be run.
 */
async function assembleWorldInfo(context) {
    try {
        const includeNames = Boolean(context.powerUserSettings?.world_info_include_names);
        const chatForWI = (context.chat ?? [])
            .filter((message) => message && !message.is_system)
            .map((message) => (includeNames ? `${message.name}: ${message.mes}` : message.mes))
            .reverse();

        const fields = context.getCharacterCardFields?.() ?? {};

        return await context.getWorldInfoPrompt(chatForWI, Number(context.maxContext) || 4096, true, {
            personaDescription: fields.persona ?? '',
            characterDescription: fields.description ?? '',
            characterPersonality: fields.personality ?? '',
            characterDepthPrompt: fields.charDepthPrompt ?? '',
            scenario: fields.scenario ?? '',
            creatorNotes: fields.creatorNotes ?? '',
            trigger: 'normal',
        });
    } catch (error) {
        console.error(`${LOG} could not assemble the world info preview`, error);
        return null;
    }
}

/** Shows what the selected card inherits, and what the prompt would be built from. */
async function showPreview() {
    const context = getContext();
    const lines = [];

    const speakerOverride = selectedKey && keyType(selectedKey) === NODE_TYPES.CHARACTER
        ? keyId(selectedKey)
        : null;
    const result = await resolve(context, speakerOverride);

    // ---- what the hierarchy contributes
    if (!result.speaker && !result.plan.size) {
        lines.push('No character is selected, so there is nothing to resolve.');
    } else {
        if (result.speaker) {
            lines.push(`Speaker: ${displayName(result.speaker)}  [${getRole(result.speaker)}]`);
        }

        const chain = [...result.plan.entries()]
            .filter(([, info]) => info.depth > 0)
            .sort((a, b) => a[1].depth - b[1].depth);

        lines.push('', chain.length ? 'Ancestors, nearest first:' : 'Ancestors: none.');
        for (const [key, info] of chain) {
            lines.push(`  ${info.depth}. ${displayName(key)}  [${getRole(key)}]`);
        }

        lines.push('', result.loadedBooks.length ? 'Lorebooks pulled in:' : 'Lorebooks pulled in: none.');
        for (const book of result.loadedBooks) {
            const detail = book.missing ? 'missing or empty' : `${book.count} entries`;
            lines.push(`  ${book.book} — level ${book.depth}, via ${book.sources.join(', ')} (${detail})`);
        }

        if (result.cardTextEntries.length) {
            lines.push('', 'Card text injected:');
            for (const entry of result.cardTextEntries) {
                lines.push(`  ${displayName(entry.key)} — level ${entry.depth}, ${entry.length} characters`);
            }
        }

        if (result.skipped.length) {
            lines.push('', 'Skipped because they are already being scanned:');
            for (const item of result.skipped) {
                lines.push(`  ${item.book} — offered by ${item.source}`);
            }
        }

        lines.push('', `Total entries added this turn: ${result.entries.length}`);
    }

    // The two sections below come from SillyTavern itself, which always works on the open
    // character - it has no notion of a node being selected on a chart.
    const openAvatar = context.characters?.[context.characterId]?.avatar;
    if (speakerOverride && openAvatar && speakerOverride !== openAvatar) {
        lines.push('', `Note: everything below is for ${displayName(charKey(openAvatar))}, who is open,`
            + ` not ${displayName(selectedKey)}, who is selected.`);
    }

    // ---- every entry that would be considered, in the order they are weighed
    const inherited = new Set(result.entries.map((entry) => `${entry.world}.${entry.uid}`));
    let combined = [];
    try {
        combined = await getSortedEntries();
    } catch (error) {
        console.error(`${LOG} could not list the combined entries`, error);
    }

    lines.push('', '─'.repeat(72), '');
    lines.push(`COMBINED WORLD INFO — ${combined.length} entries, highest priority first`);
    lines.push('(order, where it lands, whether it is always on, and where it came from)', '');

    for (const entry of combined) {
        if (entry.disable) {
            continue;
        }
        const mine = inherited.has(`${entry.world}.${entry.uid}`) ? '▸' : ' ';
        const order = String(entry.order ?? 0).padStart(5);
        const where = (POSITION_LABELS[entry.position] ?? `position ${entry.position}`)
            + (entry.position === world_info_position.atDepth ? ` ${entry.depth}` : '');
        const trigger = entry.constant ? 'always' : 'keyed';
        lines.push(`${mine} ${order}  ${where.padEnd(18)} ${trigger.padEnd(6)} ${entry.world} — ${entryLabel(entry)}`);
    }

    lines.push('', '▸ marks an entry this extension added through the hierarchy.');

    // ---- what SillyTavern would actually put in the prompt
    const assembled = await assembleWorldInfo(context);

    lines.push('', '─'.repeat(72), '');

    if (!assembled) {
        lines.push('PROMPT PREVIEW — unavailable; see the console for why.');
    } else {
        const depthEntries = assembled.worldInfoDepth ?? [];
        const anBefore = assembled.anBefore ?? [];
        const anAfter = assembled.anAfter ?? [];

        lines.push('PROMPT PREVIEW — what a generation right now would be built from.');
        lines.push('Only the world info is shown; the chat itself and the system prompt are not.', '');

        lines.push('┌─ before character definitions ' + '─'.repeat(40));
        lines.push(assembled.worldInfoBefore?.trimEnd() || '  (nothing)');
        lines.push('');
        lines.push('├─ character definitions ' + '─'.repeat(47));
        lines.push(`  (${displayName(charKey(openAvatar ?? ''))}'s description, personality and scenario)`);
        lines.push('');
        lines.push('├─ after character definitions ' + '─'.repeat(41));
        lines.push(assembled.worldInfoAfter?.trimEnd() || '  (nothing)');

        if (anBefore.length || anAfter.length) {
            lines.push('');
            lines.push('├─ author\'s note ' + '─'.repeat(55));
            for (const text of [...anBefore, ...anAfter]) {
                lines.push(String(text).trimEnd());
            }
        }

        lines.push('');
        lines.push('├─ inside the chat, at depth ' + '─'.repeat(43));
        if (!depthEntries.length) {
            lines.push('  (nothing)');
        }
        for (const item of depthEntries) {
            const texts = Array.isArray(item.entries) ? item.entries : [];
            lines.push(`  depth ${item.depth}, role ${item.role}:`);
            for (const text of texts) {
                lines.push(`    ${String(text).replace(/\n/g, '\n    ').trimEnd()}`);
            }
        }

        lines.push('└' + '─'.repeat(71));

        const total = (assembled.worldInfoString ?? '').length
            + depthEntries.reduce((sum, item) => sum
                + (Array.isArray(item.entries) ? item.entries.join('').length : 0), 0);
        lines.push('', `World info in the prompt: ${total} characters.`);
    }

    const content = el('div', {}, [
        el('h3', { textContent: 'Character Hierarchy — inheritance preview' }),
        el('div', { className: 'ch-preview', textContent: lines.join('\n') }),
    ]);

    await new Popup(content, POPUP_TYPE.DISPLAY, '', { wide: true, large: true }).show();
}

function exportTree() {
    const store = settings();
    const payload = {
        format: 'sillytavern-character-hierarchy',
        version: 1,
        exportedAt: new Date().toISOString(),
        nodes: structuredClone(store.nodes),
    };
    download(JSON.stringify(payload, null, 4), 'character-hierarchy.json', 'application/json');
}

/**
 * @param {File} file The JSON file to read.
 */
async function importTree(file) {
    try {
        const parsed = JSON.parse(await getFileText(file));
        const nodes = parsed?.nodes && typeof parsed.nodes === 'object' ? parsed.nodes : null;

        if (!nodes) {
            toastr.error('That file does not contain a hierarchy.', 'Character Hierarchy');
            return;
        }

        const confirmed = await new Popup(
            `Import ${Object.keys(nodes).length} nested cards? This replaces the current tree.`,
            POPUP_TYPE.CONFIRM,
        ).show();

        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        const store = settings();
        store.nodes = {};

        for (const [avatar, node] of Object.entries(nodes)) {
            if (typeof avatar !== 'string' || !avatar || !node || typeof node !== 'object') {
                continue;
            }
            const target = ensureNode(avatar);
            target.role = node.role === ROLE.INFO ? ROLE.INFO : ROLE.ACTOR;
            target.parent = typeof node.parent === 'string' && node.parent ? node.parent : null;
            target.books = Array.isArray(node.books) ? node.books.filter((book) => typeof book === 'string') : [];
            target.includeCardText = Boolean(node.includeCardText);
        }

        normalizeNodes();
        save();
        selectedKey = null;
        renderAll();
        toastr.success('Hierarchy imported.', 'Character Hierarchy');
    } catch (error) {
        console.error(`${LOG} import failed`, error);
        toastr.error('Could not read that file.', 'Character Hierarchy');
    }
}

/** Adds the hierarchy button to the character panel's button row. */
function addCharacterButton() {
    const row = document.querySelector('#avatar_controls .form_create_bottom_buttons_block');
    if (!row || document.getElementById('character_hierarchy_button')) {
        return;
    }

    const button = iconButton('fa-solid fa-sitemap', 'Character Hierarchy');
    button.id = 'character_hierarchy_button';

    button.addEventListener('click', () => {
        const context = getContext();
        const avatar = context.characters?.[context.characterId]?.avatar;

        if (!avatar) {
            toastr.info('Open a saved character first.', 'Character Hierarchy');
            return;
        }

        openDrawerFor(avatar);
    });

    const worldButton = row.querySelector('#world_button');
    if (worldButton) {
        worldButton.after(button);
    } else {
        row.append(button);
    }
}

/** Highlights the character panel button when the open card is part of a tree. */
function updateCharacterButton() {
    const button = document.getElementById('character_hierarchy_button');
    if (!button) {
        return;
    }

    const context = getContext();
    const avatar = context.characters?.[context.characterId]?.avatar;
    const key = avatar ? charKey(avatar) : null;
    const node = key ? getNode(key) : null;

    button.classList.toggle('ch-active', Boolean(node));

    if (!node) {
        button.title = 'Character Hierarchy — not nested';
        return;
    }

    const ancestors = getAncestors(key, Math.max(1, Number(settings().maxDepth) || 1));
    const path = [displayName(key), ...ancestors.map((item) => displayName(item.key))].reverse();
    button.title = `Character Hierarchy — ${getRole(key)}\n${path.join(' › ')}`;
}

/** Wires the settings drawer to the stored settings. */
function bindSettingsUi() {
    const store = settings();

    /** @type {[string, 'checkbox'|'number'|'text'][]} */
    const bindings = [
        ['enabled', 'checkbox'],
        ['inheritPrimaryBook', 'checkbox'],
        ['inheritAuxBooks', 'checkbox'],
        ['inheritNodeBooks', 'checkbox'],
        ['includeSelfNodeBooks', 'checkbox'],
        ['includeInfoMembers', 'checkbox'],
        ['injectCardText', 'checkbox'],
        ['cardTextConstant', 'checkbox'],
        ['debug', 'checkbox'],
        ['maxDepth', 'number'],
        ['orderPenaltyPerLevel', 'number'],
        ['cardTextDepthValue', 'number'],
        ['cardTextOrder', 'number'],
        ['cardTextPosition', 'number'],
        ['ancestorScope', 'text'],
        ['cardTextTemplate', 'text'],
    ];

    for (const [key, kind] of bindings) {
        const input = document.getElementById(`ch_${key}`);
        if (!(input instanceof HTMLInputElement
            || input instanceof HTMLSelectElement
            || input instanceof HTMLTextAreaElement)) {
            console.warn(`${LOG} settings control ch_${key} is missing`);
            continue;
        }

        if (kind === 'checkbox' && input instanceof HTMLInputElement) {
            input.checked = Boolean(store[key]);
        } else {
            input.value = String(store[key]);
        }

        input.addEventListener('change', () => {
            if (kind === 'checkbox' && input instanceof HTMLInputElement) {
                store[key] = input.checked;
            } else if (kind === 'number') {
                store[key] = Number(input.value);
            } else {
                store[key] = input.value;
            }
            save();
            renderEditor();
        });
    }

    document.getElementById('ch_open_drawer')?.addEventListener('click', () => openDrawer());
    syncZoomButton();
    document.getElementById('ch_zoom_reset')?.addEventListener('click', () => setZoom(1));

    syncFocusButton();
    document.getElementById('ch_focus')?.addEventListener('click', () => {
        settings().focusLineage = !settings().focusLineage;
        getContext().saveSettingsDebounced();
        syncFocusButton();
        renderChart();
    });

    document.getElementById('ch_add_book')?.addEventListener('click', () => addNodeOfType(NODE_TYPES.BOOK));
    document.getElementById('ch_add_persona')?.addEventListener('click', () => addNodeOfType(NODE_TYPES.PERSONA));
    document.getElementById('ch_preview')?.addEventListener('click', () => showPreview());
    document.getElementById('ch_export')?.addEventListener('click', () => exportTree());

    const fileInput = document.getElementById('ch_import_file');
    document.getElementById('ch_import')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async (event) => {
        const input = event.currentTarget;
        const file = input instanceof HTMLInputElement ? input.files?.[0] : null;
        if (file) {
            await importTree(file);
        }
        if (input instanceof HTMLInputElement) {
            input.value = '';
        }
    });
}

// #endregion

// #region slash commands

/**
 * Finds a card by name or avatar file name, defaulting to the selected character.
 * @param {*} token Name, avatar file name, or empty. Slash command arguments are untyped.
 * @returns {string|null} Avatar file name.
 */
function resolveAvatar(token) {
    const context = getContext();
    const needle = String(token ?? '').trim();

    if (!needle) {
        return context.characters?.[context.characterId]?.avatar ?? null;
    }

    const characters = context.characters ?? [];
    const exact = characters.find((character) => character?.avatar === needle);
    if (exact) {
        return exact.avatar;
    }

    const lowered = needle.toLowerCase();
    const byName = characters.find((character) => String(character?.name).toLowerCase() === lowered);
    return byName?.avatar ?? null;
}

function registerSlashCommands() {
    const context = getContext();
    const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument, ARGUMENT_TYPE } = context;

    if (!SlashCommandParser || !SlashCommand) {
        console.warn(`${LOG} slash command API unavailable, skipping command registration`);
        return;
    }

    const charArgument = () => SlashCommandNamedArgument.fromProps({
        name: 'char',
        description: 'character name or avatar file name; defaults to the selected character',
        typeList: [ARGUMENT_TYPE.STRING],
        isRequired: false,
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'hierarchy-chain',
        helpString: 'Lists a character\'s ancestors in the hierarchy, nearest first.',
        returns: 'comma-separated ancestor names',
        namedArgumentList: [charArgument()],
        callback: (args) => {
            const avatar = resolveAvatar(args?.char);
            if (!avatar) {
                return '';
            }
            const maxDepth = Math.max(1, Number(settings().maxDepth) || 1);
            return getAncestors(charKey(avatar), maxDepth).map((item) => displayName(item.key)).join(', ');
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'hierarchy-role',
        helpString: 'Gets or sets whether a character is an actor or informational.',
        returns: 'the role: actor or info',
        namedArgumentList: [charArgument()],
        unnamedArgumentList: [],
        callback: (args, value) => {
            const avatar = resolveAvatar(args?.char);
            if (!avatar) {
                return '';
            }

            const requested = String(value ?? '').trim().toLowerCase();
            if (!requested) {
                return getRole(charKey(avatar));
            }

            if (requested !== ROLE.ACTOR && requested !== ROLE.INFO) {
                toastr.warning('Role must be "actor" or "info".', 'Character Hierarchy');
                return getRole(charKey(avatar));
            }

            ensureNode(charKey(avatar)).role = requested;
            save();
            renderAll();
            return requested;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'hierarchy-parent',
        helpString: 'Gets or sets the card a character is nested under. Pass an empty value to detach it.',
        returns: 'the parent\'s name, or an empty string',
        namedArgumentList: [charArgument()],
        unnamedArgumentList: [],
        callback: (args, value) => {
            const avatar = resolveAvatar(args?.char);
            if (!avatar) {
                return '';
            }

            if (value === undefined) {
                const parent = getParent(charKey(avatar));
                return parent ? displayName(parent) : '';
            }

            const requested = String(value ?? '').trim();

            if (!requested) {
                setParent(charKey(avatar), null);
            } else {
                const parentAvatar = resolveAvatar(requested);
                if (!parentAvatar) {
                    toastr.warning(`No character called "${requested}".`, 'Character Hierarchy');
                    return '';
                }
                if (!setParent(charKey(avatar), charKey(parentAvatar))) {
                    return '';
                }
            }

            renderAll();

            const parent = getParent(charKey(avatar));
            return parent ? displayName(parent) : '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'hierarchy-books',
        helpString: 'Lists the lorebooks a character inherits through the hierarchy for the current turn.',
        returns: 'comma-separated lorebook names',
        namedArgumentList: [charArgument()],
        callback: async (args) => {
            const result = await resolve(getContext(), resolveAvatar(args?.char));
            return result.loadedBooks.map((book) => book.book).join(', ');
        },
    }));
}

// #endregion

/**
 * Loads full card data for the cards this chat can reach, so the world info scan does not
 * have to fetch anything mid-generation.
 */
async function prewarmAncestors() {
    const store = settings();
    if (!store.enabled) {
        return;
    }

    const context = getContext();
    const maxDepth = Math.max(1, Number(store.maxDepth) || 1);
    const indexes = indexByAvatar();

    /** @type {Set<string>} Node keys this chat can reach. */
    const relevant = new Set();
    const addWithAncestors = (avatar) => {
        if (!avatar) {
            return;
        }
        const key = charKey(avatar);
        relevant.add(key);
        for (const ancestor of getAncestors(key, maxDepth)) {
            relevant.add(ancestor.key);
        }
    };

    addWithAncestors(context.characters?.[context.characterId]?.avatar);

    const group = context.groupId
        ? context.groups?.find((candidate) => String(candidate.id) === String(context.groupId))
        : null;

    for (const member of Array.isArray(group?.members) ? group.members : []) {
        addWithAncestors(member);
    }

    // Only character cards can be stubs; lorebooks and personas are already in settings.
    for (const key of relevant) {
        const { type, id } = parseKey(key);
        const index = type === NODE_TYPES.CHARACTER ? indexes.get(id) : undefined;
        if (index !== undefined) {
            await unshallow(index);
        }
    }
}

export async function init() {
    if (initialized) {
        return;
    }
    initialized = true;

    settings();
    if (normalizeNodes()) {
        save();
    }

    // The panel is a top bar drawer of its own; the Extensions tab only gets a pointer to it.
    // If it cannot be built, world info inheritance still runs — it needs no interface at all.
    let panelReady = false;
    try {
        panelReady = await installDrawer();
    } catch (error) {
        console.error(`${LOG} could not build the hierarchy panel`, error);
    }

    if (panelReady) {
        try {
            const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
            document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', html);
        } catch (error) {
            console.warn(`${LOG} could not add the pointer to the Extensions tab`, error);
        }

        bindSettingsUi();
        renderAll();
    } else {
        console.warn(`${LOG} running without a panel: inheritance works, but there is nothing to edit it with`);
    }

    // These find their own anchors and warn if they are absent, so they do not need the panel.
    addCharacterButton();
    installCharacterListFilter();
    watchFilterRow();
    wireCharacterList();

    const context = getContext();
    const { eventSource, eventTypes } = context;

    if (eventTypes?.WORLDINFO_ENTRIES_LOADED) {
        eventSource.on(eventTypes.WORLDINFO_ENTRIES_LOADED, onWorldInfoEntriesLoaded);
    } else {
        console.error(`${LOG} this SillyTavern build does not emit WORLDINFO_ENTRIES_LOADED; inheritance is inactive`);
        toastr.error('Character Hierarchy needs a newer SillyTavern build.', 'Character Hierarchy');
    }

    for (const event of [eventTypes?.CHAT_CHANGED, eventTypes?.CHARACTER_PAGE_LOADED, eventTypes?.CHARACTER_EDITED]) {
        if (event) {
            eventSource.on(event, () => renderAll());
        }
    }

    if (eventTypes?.CHAT_CHANGED) {
        eventSource.on(eventTypes.CHAT_CHANGED, () => {
            prewarmAncestors().catch((error) => console.warn(`${LOG} prewarm failed`, error));
        });
    }

    registerSlashCommands();

    console.log(`${LOG} ready (${EXTENSION_PATH})`);
}

// Fallback for builds that do not call manifest activate hooks. init() is idempotent.
jQuery(() => {
    init().catch((error) => console.error(`${LOG} init failed`, error));
});
