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
    loadWorldInfo,
    newWorldInfoEntryTemplate,
    selected_world_info,
    world_info,
} from '../../../world-info.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../popup.js';
import { download, getCharaFilename, getFileText } from '../../../utils.js';
import { doNavbarIconClick } from '../../../../script.js';
import { dragElement } from '../../../RossAscends-mods.js';

const MODULE_NAME = 'characterHierarchy';
const LOG = '[CharacterHierarchy]';

/** The top bar drawer, alongside World Info, Extensions and the rest. */
const DRAWER_BUTTON_ID = 'character_hierarchy_drawer_button';
const DRAWER_ID = 'character_hierarchy_drawer';

const ROLE = Object.freeze({ ACTOR: 'actor', INFO: 'info' });
const SCOPE = Object.freeze({ SPEAKER: 'speaker', ALL_MEMBERS: 'allMembers' });

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
}

/**
 * @param {string} avatar Avatar file name, e.g. `Seraphina.png`.
 * @returns {object|null} The node, or null if the card is not part of the tree.
 */
function getNode(avatar) {
    if (!avatar) {
        return null;
    }
    const node = settings().nodes[avatar];
    return node && typeof node === 'object' ? node : null;
}

/**
 * Returns the node for a card, creating a default one if needed.
 * @param {string} avatar Avatar file name.
 * @returns {object} The node.
 */
function ensureNode(avatar) {
    const store = settings();
    if (!store.nodes[avatar] || typeof store.nodes[avatar] !== 'object') {
        store.nodes[avatar] = structuredClone(DEFAULT_NODE);
    }
    const node = store.nodes[avatar];
    if (node.role !== ROLE.INFO) {
        node.role = ROLE.ACTOR;
    }
    if (typeof node.parent !== 'string' || !node.parent) {
        node.parent = null;
    }
    if (!Array.isArray(node.books)) {
        node.books = [];
    }
    node.includeCardText = Boolean(node.includeCardText);
    return node;
}

const getParent = (avatar) => getNode(avatar)?.parent || null;
const getRole = (avatar) => (getNode(avatar)?.role === ROLE.INFO ? ROLE.INFO : ROLE.ACTOR);
const isInfo = (avatar) => getRole(avatar) === ROLE.INFO;

/** @returns {string[]} Avatars whose parent is the given avatar. */
function getChildren(avatar) {
    const nodes = settings().nodes;
    return Object.keys(nodes).filter((key) => (getParent(key) ?? null) === (avatar ?? null));
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
 * Walks up the tree from a card.
 * @param {string} avatar Starting avatar.
 * @param {number} maxDepth How many levels to climb at most.
 * @returns {{avatar: string, depth: number}[]} Ancestors, nearest first.
 */
function getAncestors(avatar, maxDepth) {
    const chain = [];
    const seen = new Set([avatar]);
    let current = avatar;

    for (let depth = 1; depth <= maxDepth; depth++) {
        const parent = getParent(current);
        if (!parent || seen.has(parent)) {
            break;
        }
        seen.add(parent);
        chain.push({ avatar: parent, depth });
        current = parent;
    }

    return chain;
}

/**
 * Repairs anything the user or a bad import could have left behind: parents that have no node
 * of their own, and parent links that close a loop.
 * @returns {boolean} True if something was changed.
 */
function normalizeNodes() {
    const store = settings();
    let changed = false;

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
 * @param {string} avatar Avatar file name.
 * @param {Map<string, number>} [indexes] A prebuilt avatar index, for callers in a loop.
 * @returns {string} A display name, falling back to the file name for deleted cards.
 */
function displayName(avatar, indexes = indexByAvatar()) {
    const character = getContext().characters?.[indexes.get(avatar)];
    return character?.name || getCharaFilename(null, { manualAvatarKey: avatar }) || avatar;
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

    const speaker = speakerOverride ?? context.characters?.[context.characterId]?.avatar ?? null;

    /** @type {{avatar: string, loadCard: boolean}[]} */
    const roots = [];

    if (speaker) {
        roots.push({ avatar: speaker, loadCard: false });
    }

    const group = context.groupId
        ? context.groups?.find((candidate) => String(candidate.id) === String(context.groupId))
        : null;

    if (group) {
        for (const member of Array.isArray(group.members) ? group.members : []) {
            if (!member || member === speaker) {
                continue;
            }
            const wanted = store.ancestorScope === SCOPE.ALL_MEMBERS
                || (store.includeInfoMembers && isInfo(member));
            if (wanted) {
                roots.push({ avatar: member, loadCard: true });
            }
        }
    }

    for (const root of roots) {
        add(root.avatar, 0, root.loadCard);
        for (const ancestor of getAncestors(root.avatar, maxDepth)) {
            add(ancestor.avatar, ancestor.depth, true);
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
        const speakerIndex = indexes.get(speaker);
        const speakerPrimary = await primaryBook(speakerIndex);
        if (speakerPrimary) {
            excluded.add(speakerPrimary);
        }
        for (const book of auxBooks(speaker)) {
            excluded.add(book);
        }
    }

    /** @type {Map<string, {depth: number, sources: string[]}>} */
    const books = new Map();
    /** @type {{avatar: string, index: number, depth: number}[]} */
    const cardTextTargets = [];

    const ordered = [...plan.entries()].sort((a, b) => a[1].depth - b[1].depth);

    for (const [avatar, info] of ordered) {
        const index = indexes.get(avatar);
        const node = getNode(avatar);
        const name = displayName(avatar, indexes);

        /** @type {string[]} */
        const candidates = [];

        if (info.loadCard && index !== undefined) {
            if (store.inheritPrimaryBook) {
                const book = await primaryBook(index);
                if (book) {
                    candidates.push(book);
                }
            }
            if (store.inheritAuxBooks) {
                candidates.push(...auxBooks(avatar));
            }
        }

        const nodeBooks = Array.isArray(node?.books) ? node.books : [];
        const wantNodeBooks = info.depth === 0 ? store.includeSelfNodeBooks : store.inheritNodeBooks;
        if (nodeBooks.length && wantNodeBooks) {
            candidates.push(...nodeBooks);
        }

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

        if (store.injectCardText && info.loadCard && node?.includeCardText && index !== undefined) {
            cardTextTargets.push({ avatar, index, depth: info.depth });
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
            cardTextEntries.push({ avatar: target.avatar, depth: target.depth, length: entry.content.length });
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
 * Builds a synthetic world info entry out of an informational card's own text.
 *
 * The entry's order and content are kept independent of tree depth so that its hash — which
 * SillyTavern uses to track sticky and cooldown timers — stays stable from turn to turn.
 *
 * @param {{avatar: string, index: number, depth: number}} target Card to render.
 * @returns {Promise<object|null>} The entry, or null if the card has no text.
 */
async function buildCardTextEntry(target) {
    const store = settings();
    const character = await unshallow(target.index);

    if (!character) {
        return null;
    }

    const content = applyTemplate(store.cardTextTemplate, {
        name: character.name ?? '',
        description: character.description ?? '',
        personality: character.personality ?? '',
        scenario: character.scenario ?? '',
        mesExamples: character.mes_example ?? '',
        creatorNotes: character.data?.creator_notes ?? character.creatorcomment ?? '',
    }).trim();

    if (!content) {
        return null;
    }

    const key = getCharaFilename(null, { manualAvatarKey: target.avatar }) || character.name;
    const constant = Boolean(store.cardTextConstant);

    return {
        ...structuredClone(newWorldInfoEntryTemplate),
        uid: 0,
        world: `Hierarchy: ${key}`,
        comment: `${character.name} (hierarchy card text)`,
        content,
        constant,
        key: constant ? [] : [character.name].filter(Boolean),
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

/** How far the pointer must travel before a click becomes a drag. */
const DRAG_THRESHOLD = 4;

/** The card whose settings the panel under the chart is showing. */
let selectedAvatar = null;

/** Live drag state, or null when nothing is being dragged. */
let dragState = null;

/** Set while the panel is hidden, so it repaints when it next opens. */
let uiDirty = true;

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
 * @returns {{positions: Map<string, {x: number, y: number, depth: number}>, width: number, height: number}}
 */
function layoutForest() {
    const store = settings();
    const indexes = indexByAvatar();
    const byName = (a, b) => displayName(a, indexes).localeCompare(displayName(b, indexes));

    /** @type {Map<string, {x: number, y: number, depth: number}>} */
    const positions = new Map();
    const seen = new Set();
    let column = 0;
    let deepest = 0;

    const place = (avatar, depth) => {
        if (seen.has(avatar)) {
            return null;
        }
        seen.add(avatar);
        deepest = Math.max(deepest, depth);

        const childCentres = [];
        for (const child of getChildren(avatar).sort(byName)) {
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

        positions.set(avatar, { x, y: depth * (NODE_HEIGHT + ROW_GAP), depth });
        return x;
    };

    const avatars = Object.keys(store.nodes);

    for (const root of avatars.filter((avatar) => !getParent(avatar)).sort(byName)) {
        place(root, 0);
        column += ROOT_GAP;
    }

    // Anything still unplaced sat in a loop normalizeNodes could not untangle. Show it anyway.
    for (const stray of avatars.filter((avatar) => !seen.has(avatar)).sort(byName)) {
        place(stray, 0);
        column += ROOT_GAP;
    }

    let widest = 0;
    for (const position of positions.values()) {
        widest = Math.max(widest, position.x);
    }

    return {
        positions,
        width: positions.size ? widest + NODE_WIDTH : 0,
        height: positions.size ? (deepest + 1) * NODE_HEIGHT + deepest * ROW_GAP : 0,
    };
}

// ---------------------------------------------------------------- cards

/**
 * One card box, draggable, usable in the chart or the tray.
 * @param {string} avatar Avatar file name.
 * @param {Map<string, number>} indexes Prebuilt avatar index.
 * @returns {HTMLElement} The box.
 */
function buildCardBox(avatar, indexes) {
    const context = getContext();
    const index = indexes.get(avatar);
    const missing = index === undefined;
    const node = getNode(avatar);

    const box = el('div', { className: 'ch-node' });
    box.dataset.avatar = avatar;
    box.dataset.chDrop = 'node';

    if (missing) {
        box.classList.add('ch-node-missing');
    }
    if (node?.role === ROLE.INFO) {
        box.classList.add('ch-node-info');
    }
    if (avatar === selectedAvatar) {
        box.classList.add('ch-node-selected');
    }

    box.append(el('img', {
        className: 'ch-node-avatar',
        src: missing ? '/img/ai4.png' : context.getThumbnailUrl('avatar', avatar),
        alt: '',
        draggable: false,
    }));

    box.append(el('div', {
        className: 'ch-node-name',
        textContent: missing ? avatar : displayName(avatar, indexes),
        title: missing ? `${avatar} — this card is not installed` : avatar,
    }));

    if (node) {
        const meta = el('div', { className: 'ch-node-meta' });
        meta.append(el('span', {
            className: 'ch-node-role',
            textContent: node.role === ROLE.INFO ? 'informational' : 'actor',
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
                title: 'This card\'s own text is injected as a world info entry.',
            }));
        }
        box.append(meta);
    }

    attachDragHandlers(box, avatar);
    return box;
}

// ---------------------------------------------------------------- dragging

/**
 * Starts a drag on pointerdown. The pointer is deliberately not captured: the floating ghost
 * ignores pointer events, so whatever is under the cursor stays the event target and doubles
 * as the drop target.
 * @param {HTMLElement} box The card box.
 * @param {string} avatar Avatar file name.
 */
function attachDragHandlers(box, avatar) {
    box.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) {
            return;
        }

        event.preventDefault();

        dragState = {
            avatar,
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
 * @returns {{element: HTMLElement, kind: string, avatar?: string, allowed: boolean}|null} The target.
 */
function findDropTarget(event) {
    if (!dragState) {
        return null;
    }

    const found = event.target instanceof Element ? event.target.closest('[data-ch-drop]') : null;
    if (!(found instanceof HTMLElement)) {
        return null;
    }

    const element = found;
    const kind = element.dataset.chDrop;

    if (kind === 'node') {
        const avatar = element.dataset.avatar;
        if (!avatar || avatar === dragState.avatar) {
            return null;
        }
        if (getParent(dragState.avatar) === avatar) {
            return { element, kind, avatar, allowed: false };
        }
        return { element, kind, avatar, allowed: !wouldCreateCycle(dragState.avatar, avatar) };
    }

    if (kind === 'tray') {
        // Only meaningful for a card that is currently in the tree.
        return { element, kind, allowed: Boolean(getNode(dragState.avatar)) };
    }

    if (kind === 'root') {
        // Meaningful for a card from the tray, or one that currently has a parent.
        const node = getNode(dragState.avatar);
        return { element, kind, allowed: !node || Boolean(node.parent) };
    }

    return null;
}

/**
 * @param {{element: Element, allowed: boolean}|null} target The new target.
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

        const ghost = dragState.source.cloneNode(true);
        ghost.classList.add('ch-ghost');
        ghost.classList.remove('ch-node-dragging', 'ch-node-selected');
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

    // A press that never travelled is a click: show the card's settings.
    if (!state.moved) {
        selectCard(state.avatar);
        return;
    }

    if (!target?.allowed) {
        return;
    }

    switch (target.kind) {
        case 'node':
            if (!setParent(state.avatar, target.avatar)) {
                return;
            }
            break;
        case 'root':
            ensureNode(state.avatar);
            setParent(state.avatar, null);
            break;
        case 'tray':
            removeNode(state.avatar);
            if (selectedAvatar === state.avatar) {
                selectedAvatar = null;
            }
            break;
        default:
            return;
    }

    renderAll();
}

// ---------------------------------------------------------------- the top bar drawer

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
    selectedAvatar = avatar;
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
    toggle.addEventListener('click', () => {
        doNavbarIconClick.call($(toggle));
        // The panel is not rendered while hidden, so catch up on the way in.
        if (uiDirty) {
            renderAll();
        }
    });

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

// ---------------------------------------------------------------- chart and tray

function renderChart() {
    const container = document.getElementById('ch_chart');
    if (!container) {
        return;
    }

    if (normalizeNodes()) {
        save();
    }

    const indexes = indexByAvatar();
    const { positions, width, height } = layoutForest();

    container.innerHTML = '';
    container.dataset.chDrop = 'root';
    container.style.width = positions.size ? `${width}px` : '';
    container.style.height = positions.size ? `${height}px` : '';

    if (!positions.size) {
        container.append(el('div', {
            className: 'ch-empty',
            textContent: 'Drag a card in from the right to start a tree.',
        }));
        return;
    }

    // Connectors go in first so the boxes sit on top of them.
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ch-links');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    for (const [avatar, position] of positions) {
        const parent = getParent(avatar);
        const parentPosition = parent ? positions.get(parent) : null;
        if (!parentPosition) {
            continue;
        }

        const fromX = parentPosition.x + NODE_WIDTH / 2;
        const fromY = parentPosition.y + NODE_HEIGHT;
        const toX = position.x + NODE_WIDTH / 2;
        const elbowY = fromY + ROW_GAP / 2;

        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('class', 'ch-link');
        path.setAttribute('d', `M ${fromX} ${fromY} V ${elbowY} H ${toX} V ${position.y}`);
        svg.append(path);
    }

    container.append(svg);

    for (const [avatar, position] of positions) {
        const box = buildCardBox(avatar, indexes);
        box.style.left = `${position.x}px`;
        box.style.top = `${position.y}px`;
        container.append(box);
    }
}

function renderTray() {
    const container = document.getElementById('ch_tray');
    if (!container) {
        return;
    }

    const store = settings();
    const indexes = indexByAvatar();
    const filter = document.getElementById('ch_tray_filter');
    const needle = (filter instanceof HTMLInputElement ? filter.value : '').trim().toLowerCase();

    container.innerHTML = '';
    container.dataset.chDrop = 'tray';

    const loose = (getContext().characters ?? [])
        .filter((character) => character?.avatar && !Object.hasOwn(store.nodes, character.avatar))
        .filter((character) => !needle || String(character.name).toLowerCase().includes(needle))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const count = document.getElementById('ch_tray_count');
    if (count) {
        count.textContent = String(loose.length);
    }

    if (!loose.length) {
        container.append(el('div', {
            className: 'ch-empty',
            textContent: needle ? 'No cards match.' : 'Every card is in a tree.',
        }));
        return;
    }

    for (const character of loose) {
        container.append(buildCardBox(character.avatar, indexes));
    }
}

/**
 * @param {string|null} avatar The card to show settings for.
 */
function selectCard(avatar) {
    selectedAvatar = avatar;
    renderChart();
    renderTray();
    renderEditor();
}

function renderAll() {
    if (selectedAvatar && !getNode(selectedAvatar)
        && !(getContext().characters ?? []).some((character) => character?.avatar === selectedAvatar)) {
        selectedAvatar = null;
    }

    updateCharacterButton();

    // No point laying out a chart nobody can see; renderAll() runs again on the way in.
    if (!isDrawerOpen()) {
        uiDirty = true;
        return;
    }

    uiDirty = false;
    renderChart();
    renderTray();
    renderEditor();
}

// ---------------------------------------------------------------- inheritance read-outs

/**
 * The books this card hands down to everything nested under it.
 * @param {string} avatar Avatar file name.
 * @returns {Promise<string[]>} Book names.
 */
async function booksPassedDown(avatar) {
    const store = settings();
    const index = indexByAvatar().get(avatar);
    const books = [];

    if (store.inheritPrimaryBook && index !== undefined) {
        const primary = await primaryBook(index);
        if (primary) {
            books.push(primary);
        }
    }
    if (store.inheritAuxBooks) {
        books.push(...auxBooks(avatar));
    }
    if (store.inheritNodeBooks) {
        books.push(...(getNode(avatar)?.books ?? []));
    }

    return [...new Set(books.filter(Boolean))];
}

/**
 * The books this card picks up from the cards above it, nearest first.
 * @param {string} avatar Avatar file name.
 * @returns {Promise<{book: string, depth: number, source: string}[]>} Inherited books.
 */
async function booksInheritedFromAbove(avatar) {
    const maxDepth = Math.max(1, Number(settings().maxDepth) || 1);
    const indexes = indexByAvatar();
    const seen = new Set();
    const inherited = [];

    for (const ancestor of getAncestors(avatar, maxDepth)) {
        for (const book of await booksPassedDown(ancestor.avatar)) {
            if (seen.has(book)) {
                continue;
            }
            seen.add(book);
            inherited.push({
                book,
                depth: ancestor.depth,
                source: displayName(ancestor.avatar, indexes),
            });
        }
    }

    return inherited;
}

// ---------------------------------------------------------------- the card editor

/**
 * Builds the live settings panel for one card. Every control applies immediately.
 * @param {string} avatar Avatar file name.
 * @param {() => void} onStructureChange Called when the card's place in the tree changes.
 * @returns {HTMLElement} The panel.
 */
function buildCardEditor(avatar, onStructureChange) {
    const context = getContext();
    const indexes = indexByAvatar();
    const node = ensureNode(avatar);
    const store = settings();
    const installed = indexes.has(avatar);

    const panel = el('div', { className: 'ch-editor' });

    const header = el('div', { className: 'ch-editor-header' });
    header.append(el('img', {
        className: 'ch-editor-avatar',
        src: installed ? context.getThumbnailUrl('avatar', avatar) : '/img/ai4.png',
        alt: '',
        draggable: false,
    }));
    header.append(el('div', { className: 'ch-editor-title' }, [
        el('div', { className: 'ch-editor-name', textContent: displayName(avatar, indexes) }),
        el('div', { className: 'ch-editor-file', textContent: installed ? avatar : `${avatar} — not installed` }),
    ]));

    const remove = iconButton('fa-solid fa-trash-can', 'Remove this card from the tree');
    remove.addEventListener('click', () => {
        removeNode(avatar);
        selectedAvatar = null;
        onStructureChange();
    });
    header.append(remove);
    panel.append(header);

    const grid = el('div', { className: 'ch-editor-grid' });

    const roleSelect = el('select', { className: 'text_pole' });
    roleSelect.append(el('option', { value: ROLE.ACTOR, textContent: 'Actor — takes part in the roleplay' }));
    roleSelect.append(el('option', { value: ROLE.INFO, textContent: 'Informational — a lore container only' }));
    roleSelect.value = node.role;
    roleSelect.addEventListener('change', () => {
        ensureNode(avatar).role = roleSelect.value === ROLE.INFO ? ROLE.INFO : ROLE.ACTOR;
        save();
        renderChart();
        renderTray();
        updateCharacterButton();
    });
    grid.append(el('div', {}, [field('Role', roleSelect)]));

    const parentSelect = el('select', { className: 'text_pole' });
    parentSelect.append(el('option', { value: '', textContent: '— none (top of its tree) —' }));

    const candidates = (context.characters ?? [])
        .filter((character) => character?.avatar
            && character.avatar !== avatar
            && !wouldCreateCycle(avatar, character.avatar))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    for (const character of candidates) {
        parentSelect.append(el('option', {
            value: character.avatar,
            textContent: isInfo(character.avatar) ? `${character.name} (info)` : character.name,
        }));
    }
    if (node.parent && !candidates.some((character) => character.avatar === node.parent)) {
        parentSelect.append(el('option', { value: node.parent, textContent: `${node.parent} (not installed)` }));
    }
    parentSelect.value = node.parent ?? '';
    parentSelect.addEventListener('change', () => {
        if (setParent(avatar, parentSelect.value || null)) {
            onStructureChange();
        }
    });
    grid.append(el('div', {}, [field('Nested under', parentSelect, 'Or just drag the card onto its new parent.')]));
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
        const own = await booksPassedDown(avatar);
        passedDown.textContent = own.length
            ? `Everything nested under this card inherits: ${own.join(', ')}`
            : 'This card has no lorebooks to pass down yet.';

        inheritedList.innerHTML = '';
        const inherited = await booksInheritedFromAbove(avatar);
        if (!inherited.length) {
            inheritedList.append(el('div', {
                className: 'ch-hint',
                textContent: 'Nothing sits above this card, so it inherits nothing.',
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
        ensureNode(avatar).books = [...booksSelect.selectedOptions].map((option) => option.value);
        save();
        renderChart();
        renderTray();
        refreshReadouts();
    });

    panel.append(field('Extra lorebooks held on this card', filterInput,
        'Tracked by this extension, so an informational card can carry books without being opened as a character. Ctrl-click or shift-click to pick several.'));
    panel.append(booksSelect);
    panel.append(passedDown);

    const cardTextLabel = el('label', { className: 'checkbox_label' });
    const cardTextCheckbox = el('input', { type: 'checkbox', checked: node.includeCardText });
    cardTextLabel.append(cardTextCheckbox, el('span', {
        textContent: 'Inject this card\'s own text as a world info entry',
    }));
    cardTextCheckbox.addEventListener('change', () => {
        ensureNode(avatar).includeCardText = cardTextCheckbox.checked;
        save();
        renderChart();
        renderTray();
    });
    panel.append(cardTextLabel);
    panel.append(el('div', {
        className: 'ch-hint',
        textContent: store.injectCardText
            ? 'Uses the template in the "Informational card text" section above.'
            : 'Card text injection is switched off globally, so this will have no effect yet.',
    }));

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

    if (!selectedAvatar) {
        container.append(el('div', {
            className: 'ch-hint',
            textContent: 'Click a card to set its role and the lorebooks it passes down. Drag a card onto another to nest it, onto the empty chart to make it a root, or back to the tray to take it out.',
        }));
        return;
    }

    container.append(buildCardEditor(selectedAvatar, renderAll));
}

// ---------------------------------------------------------------- panel chrome

/** Shows what the currently selected character would inherit. */
async function showPreview() {
    const context = getContext();
    const lines = [];

    const result = await resolve(context, selectedAvatar);

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
        for (const [avatar, info] of chain) {
            lines.push(`  ${info.depth}. ${displayName(avatar)}  [${getRole(avatar)}]`);
        }

        lines.push('', result.loadedBooks.length ? 'Lorebooks pulled in:' : 'Lorebooks pulled in: none.');
        for (const book of result.loadedBooks) {
            const detail = book.missing ? 'missing or empty' : `${book.count} entries`;
            lines.push(`  ${book.book} — level ${book.depth}, via ${book.sources.join(', ')} (${detail})`);
        }

        if (result.cardTextEntries.length) {
            lines.push('', 'Card text injected:');
            for (const entry of result.cardTextEntries) {
                lines.push(`  ${displayName(entry.avatar)} — level ${entry.depth}, ${entry.length} characters`);
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
        selectedAvatar = null;
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
    const node = avatar ? getNode(avatar) : null;

    button.classList.toggle('ch-active', Boolean(node));

    if (!node) {
        button.title = 'Character Hierarchy — not nested';
        return;
    }

    const ancestors = getAncestors(avatar, Math.max(1, Number(settings().maxDepth) || 1));
    const path = [displayName(avatar), ...ancestors.map((item) => displayName(item.avatar))].reverse();
    button.title = `Character Hierarchy — ${getRole(avatar)}\n${path.join(' › ')}`;
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
    document.getElementById('ch_tray_filter')?.addEventListener('input', () => renderTray());
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
            return getAncestors(avatar, maxDepth).map((item) => displayName(item.avatar)).join(', ');
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
                return getRole(avatar);
            }

            if (requested !== ROLE.ACTOR && requested !== ROLE.INFO) {
                toastr.warning('Role must be "actor" or "info".', 'Character Hierarchy');
                return getRole(avatar);
            }

            ensureNode(avatar).role = requested;
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
                const parent = getParent(avatar);
                return parent ? displayName(parent) : '';
            }

            const requested = String(value ?? '').trim();

            if (!requested) {
                setParent(avatar, null);
            } else {
                const parentAvatar = resolveAvatar(requested);
                if (!parentAvatar) {
                    toastr.warning(`No character called "${requested}".`, 'Character Hierarchy');
                    return '';
                }
                if (!setParent(avatar, parentAvatar)) {
                    return '';
                }
            }

            renderAll();

            const parent = getParent(avatar);
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

    const relevant = new Set();
    const addWithAncestors = (avatar) => {
        if (!avatar) {
            return;
        }
        relevant.add(avatar);
        for (const ancestor of getAncestors(avatar, maxDepth)) {
            relevant.add(ancestor.avatar);
        }
    };

    addWithAncestors(context.characters?.[context.characterId]?.avatar);

    const group = context.groupId
        ? context.groups?.find((candidate) => String(candidate.id) === String(context.groupId))
        : null;

    for (const member of Array.isArray(group?.members) ? group.members : []) {
        addWithAncestors(member);
    }

    for (const avatar of relevant) {
        const index = indexes.get(avatar);
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
    try {
        if (!await installDrawer()) {
            return;
        }
    } catch (error) {
        console.error(`${LOG} could not build the hierarchy panel`, error);
        return;
    }

    try {
        const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
        document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', html);
    } catch (error) {
        console.warn(`${LOG} could not add the pointer to the Extensions tab`, error);
    }

    bindSettingsUi();
    addCharacterButton();
    renderAll();

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
