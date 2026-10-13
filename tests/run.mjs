/**
 * Behavioural tests for the Character Hierarchy extension.
 *
 * The extension imports SillyTavern's own modules by relative path, so the test lays out a
 * throwaway copy of that directory shape with stub modules in place of the real ones, drops
 * the extension into it, and drives it through jsdom. The settings panel is loaded from the
 * real settings.html, which keeps the markup and the code that binds to it honest.
 *
 *   npm install && npm test
 */
import { JSDOM } from 'jsdom';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXT_SRC = path.resolve(HERE, '..');

const TMP = path.join(HERE, '.tmp');
const SCRIPTS = path.join(TMP, 'public/scripts');
const EXT_DIR = path.join(SCRIPTS, 'extensions/third-party/CH');

rmSync(TMP, { recursive: true, force: true });
mkdirSync(EXT_DIR, { recursive: true });
cpSync(path.join(HERE, 'stubs/public'), path.join(TMP, 'public'), { recursive: true });
cpSync(path.join(EXT_SRC, 'index.js'), path.join(EXT_DIR, 'index.js'));

globalThis.__templateDir = EXT_SRC;

// ---------- DOM ----------
const dom = new JSDOM(`<!doctype html><html><body>
    <div id="top-settings-holder"><div id="WI-SP-button" class="drawer"></div><div id="rightNavHolder" class="drawer"><div class="drawer-toggle"><div id="rightNavDrawerIcon" class="drawer-icon closedIcon"></div></div><nav id="right-nav-panel" class="drawer-content closedDrawer"></nav><input type="checkbox" id="rm_button_panel_pin"></div><div id="persona-management-button" class="drawer"><div class="drawer-toggle"></div><div class="drawer-content closedDrawer"></div></div></div><div id="extensions_settings2"></div><div id="rm_print_characters_block"></div><div id="rm_characters_block"><div class="tags rm_tag_filter"><span class="tag actionable manageTags"></span></div></div>
    <div id="avatar_controls">
        <div class="form_create_bottom_buttons_block">
            <div id="favorite_button"></div>
            <div id="world_button"></div>
            <div id="export_button"></div>
        </div>
    </div>
</body></html>`, { url: 'http://localhost/' });

for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLInputElement',
    'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLOptionElement', 'Node',
    'DocumentFragment', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'File', 'MutationObserver']) {
    globalThis[key] = key === 'window' ? dom.window : dom.window[key];
}

const warnings = [];
const errors = [];
const origWarn = console.warn;
const origError = console.error;
console.warn = (...a) => { warnings.push(a.join(' ')); };
console.error = (...a) => { errors.push(a.join(' ')); };

globalThis.toastr = { info: () => {}, success: () => {}, warning: (m) => warnings.push('toastr.warning ' + m), error: (m) => warnings.push('toastr.error ' + m) };
// index.js uses jQuery only to hand elements to SillyTavern helpers; a thin wrapper is enough.
globalThis.jQuery = (arg) => (typeof arg === 'function' ? undefined : Object.assign([arg], { 0: arg }));
globalThis.$ = globalThis.jQuery; // suppress the ready-fallback; we call init() ourselves

// ---------- fake SillyTavern ----------
const CHARACTERS = [
    { avatar: 'Brant.png', name: 'Sir Brant', description: 'A knight.', data: { extensions: { world: 'Brant Book' } } },
    { avatar: 'Vance.png', name: 'House Vance', description: 'An old house with older debts.', personality: 'Proud', data: { extensions: { world: 'Vance Secrets' } } },
    { avatar: 'Aldia.png', name: 'Kingdom of Aldia', description: 'A kingdom of salt and rain.', data: { extensions: { world: 'Aldia Lore' } } },
    { avatar: 'Mira.png', name: 'Mira', description: 'A squire.', data: { extensions: { world: 'Mira Book' } } },
    { avatar: 'Weather.png', name: 'Aldian Weather', description: 'It rains for nine months.', data: { extensions: {} } },
    { avatar: 'Shallow.png', name: 'Shallow One', shallow: true, data: { extensions: {} } },
];

globalThis.__books = {
    'Brant Book': { entries: { 0: { uid: 0, key: ['brant'], content: 'brant own', order: 100 } } },
    'Vance Secrets': { entries: { 0: { uid: 0, key: ['vance'], content: 'vance 1', order: 100 }, 1: { uid: 1, key: ['debt'], content: 'vance 2', order: 90 } } },
    'Aldia Lore': { entries: { 0: { uid: 0, key: ['aldia'], content: 'aldia 1', order: 100 } } },
    'Mira Book': { entries: { 0: { uid: 0, key: ['mira'], content: 'mira own', order: 100 } } },
    'Global Book': { entries: { 0: { uid: 0, key: ['g'], content: 'global', order: 100 } } },
    'Shared Book': { entries: { 0: { uid: 0, key: ['s'], content: 'shared', order: 100 } } },
    'Node Extra': { entries: { 0: { uid: 0, key: ['x'], content: 'node extra', order: 100 } } },
};

const handlers = new Map();
const eventSource = {
    on(event, cb) { (handlers.get(event) ?? handlers.set(event, []).get(event)).push(cb); },
    async emit(event, ...args) { for (const cb of handlers.get(event) ?? []) await cb(...args); },
};

const eventTypes = {
    WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
    CHAT_CHANGED: 'chat_id_changed',
    CHARACTER_PAGE_LOADED: 'character_page_loaded',
    CHARACTER_EDITED: 'character_edited',
};

const commands = new Map();

globalThis.__ctx = {
    characters: CHARACTERS,
    characterId: undefined,
    groupId: undefined,
    groups: [],
    chatMetadata: {},
    powerUserSettings: {
        personas: { 'me.png': 'Traveller' },
        persona_descriptions: { 'me.png': { description: 'A wanderer.', lorebook: 'Shared Book' } },
    },
    eventSource,
    eventTypes,
    saveSettingsDebounced: () => {},
    selectCharacterById: async (id) => { globalThis.__characterOpened = Number(id); },
    unshallowCharacter: async (id) => { CHARACTERS[Number(id)].shallow = false; CHARACTERS[Number(id)].description = 'unshallowed text'; },
    getThumbnailUrl: (type, file) => `/thumbnail?type=${type}&file=${file}`,
    getWorldInfoNames: () => Object.keys(globalThis.__books),
    SlashCommandParser: { addCommandObject: (c) => commands.set(c.name, c) },
    SlashCommand: { fromProps: (p) => p },
    SlashCommandNamedArgument: { fromProps: (p) => p },
    ARGUMENT_TYPE: { STRING: 'string' },
};

// ---------- load the extension ----------
const { extension_settings } = await import(path.join(SCRIPTS, 'extensions.js'));
const { FILTER_STATES: FILTER_STATES_ORDER } = await import(path.join(SCRIPTS, 'filters.js'));
const wi = await import(path.join(SCRIPTS, 'world-info.js'));
const ext = await import(path.join(EXT_DIR, 'index.js'));

await ext.init();

// ---------- test plumbing ----------
let pass = 0;
const failures = [];
function check(name, condition, detail = '') {
    if (condition) { pass++; origWarn(`  ok   ${name}`); }
    else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); origWarn(`  FAIL ${name} ${detail}`); }
}

const S = () => extension_settings.characterHierarchy;

/** Node keys are typed: a character card's key is its avatar behind a `char:` prefix. */
const K = (avatar) => `char:${avatar}`;
/** The stored node for a character avatar. */
const N = (avatar) => S().nodes[K(avatar)];

function setTree(nodes) {
    S().nodes = Object.fromEntries(Object.entries(structuredClone(nodes))
        .map(([avatar, value]) => [K(avatar), value]));
}
const node = (parent, extra = {}) => ({
    parent: parent ? K(parent) : null, role: 'actor', books: [], includeCardText: false, ...extra,
});

const idxOf = (avatar) => String(CHARACTERS.findIndex((c) => c.avatar === avatar));

/** The extension redraws on this event, so it is the public way to force a repaint. */
const redraw = () => eventSource.emit(eventTypes.CHARACTER_PAGE_LOADED);

async function scan() {
    const payload = { globalLore: [], characterLore: [], chatLore: [], personaLore: [] };
    await eventSource.emit(eventTypes.WORLDINFO_ENTRIES_LOADED, payload);
    return payload.characterLore;
}
const worldsOf = (entries) => [...new Set(entries.map((e) => e.world))].sort();

// ---------- T1: settings panel ----------
check('settings panel is inserted', !!document.getElementById('character_hierarchy_settings'));
check('chart and editor containers exist',
    !!document.getElementById('ch_chart') && !!document.getElementById('ch_editor'));
check('the tray is gone, cards come from SillyTavern\'s own list',
    !document.getElementById('ch_tray') && !document.getElementById('ch_tray_filter'));
const missingControls = warnings.filter((w) => w.includes('settings control'));
check('every settings control is present', missingControls.length === 0, missingControls.join('; '));
check('init logged no errors', errors.length === 0, errors.join('; '));

// ---------- T2: character panel button ----------
const button = document.getElementById('character_hierarchy_button');
check('character panel button injected', !!button);
check('button sits right after the lore button',
    button?.previousElementSibling?.id === 'world_button',
    button?.previousElementSibling?.id);

// ---------- T2b: the top bar drawer ----------
const drawerButton = document.getElementById('character_hierarchy_drawer_button');
const drawerContent = document.getElementById('character_hierarchy_drawer');

check('a drawer is added to the top bar',
    drawerButton?.parentElement?.id === 'top-settings-holder', drawerButton?.parentElement?.id);
check('it sits next to World Info', drawerButton?.previousElementSibling?.id === 'WI-SP-button');
check('it has a top bar icon',
    !!drawerButton?.querySelector('.drawer-toggle .drawer-icon.fa-sitemap.closedIcon'));
check('it starts closed', drawerContent?.classList.contains('closedDrawer'));
check('the whole panel lives in the drawer',
    !!drawerContent?.querySelector('#ch_chart') && !!drawerContent?.querySelector('#ch_editor')
    && !!drawerContent?.querySelector('#ch_enabled')
    && !!drawerContent?.querySelector('#ch_add_book')
    && !!drawerContent?.querySelector('#ch_add_persona'));
check('the drag grabber is named after the panel, as dragElement expects',
    !!drawerContent?.querySelector('#character_hierarchy_drawerheader.drag-grabber'));
check('panel dragging is left alone unless movingUI is on', globalThis.__dragged === undefined);
check('the Extensions tab holds only a pointer',
    !!document.getElementById('ch_open_drawer')
    && !document.querySelector('#character_hierarchy_settings #ch_chart'));
check('the chart is not painted while the drawer is closed',
    document.getElementById('ch_chart').children.length === 0,
    String(document.getElementById('ch_chart').children.length));

document.getElementById('ch_open_drawer').dispatchEvent(new dom.window.Event('click'));
await new Promise((resolve) => setTimeout(resolve, 0)); // the toggle repaints asynchronously
check('the Extensions pointer opens the drawer', drawerContent.classList.contains('openDrawer'));
check('the icon flips to open',
    !!drawerButton.querySelector('.drawer-icon.openIcon'));
check('opening the drawer paints the chart',
    document.getElementById('ch_chart').children.length > 0,
    String(document.getElementById('ch_chart').children.length));

// ---------- T3: ancestors contribute, speaker's own and global books do not ----------
wi.setGlobalBooks(['Global Book']);
setTree({ 'Brant.png': node(null), 'Vance.png': node('Aldia.png'), 'Aldia.png': node(null) });
N('Brant.png').parent = K('Vance.png');
globalThis.__ctx.characterId = '0'; // Brant speaks

let entries = await scan();
check('inherits both ancestor books',
    JSON.stringify(worldsOf(entries)) === JSON.stringify(['Aldia Lore', 'Vance Secrets']),
    JSON.stringify(worldsOf(entries)));
check('does not re-add the speaker\'s own book', !entries.some((e) => e.world === 'Brant Book'));
check('does not re-add a globally selected book', !entries.some((e) => e.world === 'Global Book'));
check('entry count matches the fixtures', entries.length === 3, String(entries.length));
check('entries carry their source world and uid',
    entries.every((e) => typeof e.world === 'string' && e.uid !== undefined));

// ---------- T4: a book already covered by the chat lorebook is skipped ----------
globalThis.__ctx.chatMetadata = { world_info: 'Aldia Lore' };
entries = await scan();
check('skips a book the chat lorebook already scans',
    JSON.stringify(worldsOf(entries)) === JSON.stringify(['Vance Secrets']),
    JSON.stringify(worldsOf(entries)));
globalThis.__ctx.chatMetadata = {};

// ---------- T5: persona lorebook exclusion ----------
const basePowerUser = globalThis.__ctx.powerUserSettings;
globalThis.__ctx.powerUserSettings = { ...basePowerUser, persona_description_lorebook: 'Vance Secrets' };
entries = await scan();
check('skips a book the persona already scans', !entries.some((e) => e.world === 'Vance Secrets'));
globalThis.__ctx.powerUserSettings = basePowerUser;

// ---------- T6: order penalty by distance ----------
S().orderPenaltyPerLevel = 10;
entries = await scan();
const vance = entries.find((e) => e.world === 'Vance Secrets' && e.uid === 0);
const aldia = entries.find((e) => e.world === 'Aldia Lore');
check('nearer ancestors keep a higher order than distant ones',
    vance.order === 90 && aldia.order === 80, `vance=${vance.order} aldia=${aldia.order}`);
S().orderPenaltyPerLevel = 0;

// ---------- T7: maxDepth caps the walk ----------
S().maxDepth = 1;
entries = await scan();
check('maxDepth stops the climb',
    JSON.stringify(worldsOf(entries)) === JSON.stringify(['Vance Secrets']),
    JSON.stringify(worldsOf(entries)));
S().maxDepth = 16;

// ---------- T8: extension-held extra books ----------
setTree({
    'Brant.png': node('Vance.png', { books: ['Node Extra'] }),
    'Vance.png': node(null, { books: ['Shared Book'] }),
});
entries = await scan();
check('speaker\'s own extra books are loaded', entries.some((e) => e.world === 'Node Extra'));
check('ancestor extra books are loaded', entries.some((e) => e.world === 'Shared Book'));

S().includeSelfNodeBooks = false;
entries = await scan();
check('speaker extra books can be switched off', !entries.some((e) => e.world === 'Node Extra'));
check('ancestor extra books still load', entries.some((e) => e.world === 'Shared Book'));
S().includeSelfNodeBooks = true;

// ---------- T9: a book shared by two ancestors loads once ----------
setTree({
    'Brant.png': node('Vance.png'),
    'Vance.png': node('Aldia.png', { books: ['Shared Book'] }),
    'Aldia.png': node(null, { books: ['Shared Book'] }),
});
entries = await scan();
check('a book shared by two ancestors is loaded once',
    entries.filter((e) => e.world === 'Shared Book').length === 1,
    String(entries.filter((e) => e.world === 'Shared Book').length));

// ---------- T10: informational card text ----------
setTree({
    'Brant.png': node('Weather.png'),
    'Weather.png': node(null, { role: 'info', includeCardText: true }),
});
entries = await scan();
const cardText = entries.find((e) => e.world?.startsWith('Hierarchy:'));
check('card text entry is produced', !!cardText);
check('card text uses the ancestor\'s own description',
    cardText?.content === '[Aldian Weather]\nIt rains for nine months.',
    JSON.stringify(cardText?.content));
check('card text is constant by default', cardText?.constant === true);
check('card text carries the full entry template', cardText && 'selectiveLogic' in cardText && 'groupWeight' in cardText);

S().injectCardText = false;
entries = await scan();
check('card text injection can be switched off globally',
    !entries.some((e) => e.world?.startsWith('Hierarchy:')));
S().injectCardText = true;

// ---------- T11: group chats ----------
globalThis.__ctx.groupId = 'g1';
globalThis.__ctx.groups = [{ id: 'g1', members: ['Brant.png', 'Mira.png', 'Weather.png'], disabled_members: ['Weather.png'] }];
setTree({
    'Brant.png': node('Vance.png'),
    'Vance.png': node(null),
    'Mira.png': node(null),
    'Weather.png': node(null, { role: 'info', includeCardText: true }),
});
entries = await scan();
check('an informational group member contributes while Brant speaks',
    entries.some((e) => e.world?.startsWith('Hierarchy:')));
check('another actor\'s own book is not pulled in under speaker scope',
    !entries.some((e) => e.world === 'Mira Book'));

S().ancestorScope = 'allMembers';
entries = await scan();
check('allMembers scope pulls in every member\'s books',
    entries.some((e) => e.world === 'Mira Book'), JSON.stringify(worldsOf(entries)));
S().ancestorScope = 'speaker';

S().includeInfoMembers = false;
entries = await scan();
check('informational members can be excluded',
    !entries.some((e) => e.world?.startsWith('Hierarchy:')));
S().includeInfoMembers = true;
globalThis.__ctx.groupId = undefined;
globalThis.__ctx.groups = [];

// ---------- T12: shallow ancestors are loaded on demand ----------
CHARACTERS[5].shallow = true;
CHARACTERS[5].description = '';
setTree({ 'Brant.png': node('Shallow.png'), 'Shallow.png': node(null, { role: 'info', includeCardText: true }) });
entries = await scan();
check('a shallow ancestor is loaded before its text is read',
    entries.some((e) => e.content?.includes('unshallowed text')),
    JSON.stringify(entries.map((e) => e.content)));

// ---------- T13: cycles ----------
setTree({ 'Brant.png': node('Vance.png'), 'Vance.png': node('Aldia.png'), 'Aldia.png': node(null) });
const parentCmd = commands.get('hierarchy-parent');
parentCmd.callback({ char: 'Kingdom of Aldia' }, 'Sir Brant');
check('a parent link that would close a loop is refused',
    N('Aldia.png').parent === null, String(N('Aldia.png').parent));

// a loop smuggled in by hand must not hang the scan
N('Aldia.png').parent = K('Brant.png');
entries = await scan();
check('a hand-made loop still terminates', Array.isArray(entries));

// ---------- T14: slash commands ----------
setTree({ 'Brant.png': node('Vance.png'), 'Vance.png': node('Aldia.png'), 'Aldia.png': node(null) });
check('/hierarchy-chain lists ancestors nearest first',
    commands.get('hierarchy-chain').callback({ char: 'Sir Brant' }) === 'House Vance, Kingdom of Aldia',
    commands.get('hierarchy-chain').callback({ char: 'Sir Brant' }));
check('/hierarchy-role reads a role',
    commands.get('hierarchy-role').callback({ char: 'Sir Brant' }, '') === 'actor');
check('/hierarchy-role writes a role',
    commands.get('hierarchy-role').callback({ char: 'Sir Brant' }, 'info') === 'info'
    && N('Brant.png').role === 'info');
check('/hierarchy-role rejects nonsense',
    commands.get('hierarchy-role').callback({ char: 'Sir Brant' }, 'banana') === 'info');
check('/hierarchy-parent reads a parent',
    commands.get('hierarchy-parent').callback({ char: 'Sir Brant' }) === 'House Vance');
check('/hierarchy-parent detaches on an empty value',
    commands.get('hierarchy-parent').callback({ char: 'Kingdom of Aldia' }, '') === '');
const booksOut = await commands.get('hierarchy-books').callback({ char: 'Sir Brant' });
check('/hierarchy-books lists inherited books',
    booksOut.includes('Vance Secrets') && booksOut.includes('Aldia Lore'), booksOut);

// ---------- T15: the chart, fed from SillyTavern's own character list ----------
S().nodes = {};
await redraw();
const chart = document.getElementById('ch_chart');
const editor = document.getElementById('ch_editor');
const charList = document.getElementById('rm_print_characters_block');
const parentCmd2 = commands.get('hierarchy-parent');

const pev = (type, x, y) => new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
const nodesIn = (root) => [...root.querySelectorAll('.ch-node')];
const nodeFor = (root, key) => nodesIn(root).find((n) => n.dataset.key === key);

/** Press, travel past the drag threshold, release over the target. */
function dragTo(fromEl, toEl) {
    fromEl.dispatchEvent(pev('pointerdown', 0, 0));
    toEl.dispatchEvent(pev('pointermove', 60, 60));
    toEl.dispatchEvent(pev('pointerup', 60, 60));
}
/** Press and release without travelling: a click. */
function clickCard(el) {
    el.dispatchEvent(pev('pointerdown', 10, 10));
    el.dispatchEvent(pev('pointerup', 10, 10));
}

/**
 * Lets the double-click window lapse. The suite clicks far faster than a person, so two
 * unrelated clicks on the same node would otherwise read as a double click.
 */
const settleClick = () => new Promise((resolve) => setTimeout(resolve, 450));

/** Drives the "add a lorebook/persona" picker, choosing a specific entry. */
async function addViaPicker(buttonId, value) {
    globalThis.__onPopup = (content) => { content.querySelector('select').value = value; };
    document.getElementById(buttonId).dispatchEvent(new dom.window.Event('click'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    globalThis.__onPopup = null;
}
const addLorebook = (name) => addViaPicker('ch_add_book', name);
const addPersona = (id) => addViaPicker('ch_add_persona', id);

/** Paints SillyTavern's character list the way printCharacters would. */
function paintCharacterList() {
    charList.innerHTML = '';
    CHARACTERS.forEach((character, index) => {
        const row = document.createElement('div');
        row.className = 'character_select';
        row.dataset.chid = String(index);
        const avatar = document.createElement('img');
        avatar.src = `/thumbnail?type=avatar&file=${character.avatar}`;
        const name = document.createElement('span');
        name.className = 'ch_name';
        name.textContent = character.name;
        row.append(avatar, name);
        charList.append(row);
    });
}
const listRow = (avatar) => [...charList.querySelectorAll('.character_select')]
    .find((row) => CHARACTERS[Number(row.dataset.chid)].avatar === avatar);

paintCharacterList();
await new Promise((resolve) => setTimeout(resolve, 0)); // the observer decorates asynchronously

check('an empty chart points at the character list', chart.textContent.includes('Drag a character here'));
check('character list rows become drag sources',
    [...charList.querySelectorAll('.character_select')].every((row) => row.dataset.chDragWired === 'true'));
check('no row is dimmed while the chart is empty',
    !charList.querySelector('.ch-on-chart'));

// A native image drag out of a row ends up in SillyTavern's character importer, which then
// reports the thumbnail as a corrupt card. Only our own pointer drag should run.
const nativeDrag = new dom.window.Event('dragstart', { bubbles: true, cancelable: true });
listRow('Brant.png').querySelector('img').dispatchEvent(nativeDrag);
check('a native image drag out of a list row is suppressed', nativeDrag.defaultPrevented);
check('rows are not natively draggable', listRow('Brant.png').draggable === false);

// SillyTavern's bulk edit overlay arms a long-press timer on a row's mousedown and cancels it
// on mouseup over the row or the list. Our drag releases over the chart, so unless we say the
// press is over the timer runs on and switches bulk edit mode on by itself.
let sawMouseUp = 0;
let sawBubbledMouseUp = 0;
const pressedRow = listRow('Weather.png');
pressedRow.addEventListener('mouseup', () => { sawMouseUp += 1; });
charList.addEventListener('mouseup', () => { sawBubbledMouseUp += 1; });
pressedRow.dispatchEvent(pev('pointerdown', 0, 0));
chart.dispatchEvent(pev('pointermove', 60, 60));
check('a list drag tells the row its press is over', sawMouseUp === 1, String(sawMouseUp));
check('and that reaches the list, which is where the other cancel lives',
    sawBubbledMouseUp === 1, String(sawBubbledMouseUp));
chart.dispatchEvent(pev('pointerup', 60, 60));

// That drag landed a node; clear it so the next block starts from an empty chart.
S().nodes = {};
await redraw();

// Pressing on a row's text must not start a text selection: the browser takes the pointer
// over for it and cancels the drag. jsdom has no selection model, so this pins the marker
// attribute and the stylesheet rule that suppresses it to each other.
const wiredMarker = listRow('Brant.png').getAttribute('data-ch-drag-wired');
const stylesheet = readFileSync(path.join(EXT_SRC, 'style.css'), 'utf-8');
check('wired rows carry the marker the stylesheet keys off', wiredMarker === 'true', String(wiredMarker));
check('the stylesheet stops text selection on wired rows',
    /\.character_select\[data-ch-drag-wired\][^}]*user-select:\s*none/s.test(stylesheet));

// ---------- T16: dragging a character out of the list ----------
dragTo(listRow('Aldia.png'), chart);
check('dropping a list row on empty chart space adds it as a root',
    N('Aldia.png')?.parent === null && nodesIn(chart).length === 1,
    JSON.stringify(Object.keys(S().nodes)));
check('the row is now dimmed in the character list',
    listRow('Aldia.png').classList.contains('ch-on-chart'));

dragTo(listRow('Vance.png'), nodeFor(chart, K('Aldia.png')));
check('dropping a list row on a node nests it there',
    N('Vance.png')?.parent === K('Aldia.png'), JSON.stringify(N('Vance.png')));

dragTo(listRow('Brant.png'), nodeFor(chart, K('Vance.png')));
dragTo(listRow('Mira.png'), nodeFor(chart, K('Vance.png')));
check('two cards can share a parent',
    N('Brant.png').parent === K('Vance.png') && N('Mira.png').parent === K('Vance.png'));

// ---------- T17: layout ----------
const pos = (avatar) => {
    const n = nodeFor(chart, K(avatar));
    return [parseFloat(n.style.left), parseFloat(n.style.top)];
};
check('each level sits one row lower',
    pos('Aldia.png')[1] === 0 && pos('Vance.png')[1] === 156 && pos('Brant.png')[1] === 312,
    JSON.stringify([pos('Aldia.png')[1], pos('Vance.png')[1], pos('Brant.png')[1]]));
check('siblings sit in adjacent columns',
    Math.abs(pos('Mira.png')[0] - pos('Brant.png')[0]) === 134);
check('a parent is centred over its children',
    pos('Vance.png')[0] === (pos('Brant.png')[0] + pos('Mira.png')[0]) / 2);
check('one connector per parent-child link',
    chart.querySelectorAll('svg.ch-links path.ch-link').length === 3,
    String(chart.querySelectorAll('svg.ch-links path.ch-link').length));
check('the chart box includes its own padding, so a small tree never scrolls',
    chart.style.width === '278px' && chart.style.height === '448px',
    `${chart.style.width} x ${chart.style.height}`);
check('the padding is published to CSS from the one place it is defined',
    chart.style.getPropertyValue('--ch-pad') === '14px');

// ---------- T18: a drop that would close a loop is refused ----------
dragTo(nodeFor(chart, K('Aldia.png')), nodeFor(chart, K('Brant.png')));
check('dropping a node onto its own descendant is refused', N('Aldia.png').parent === null);
check('the refused drop left the tree untouched', N('Brant.png').parent === K('Vance.png'));

// ---------- T19: taking a node off the chart ----------
dragTo(nodeFor(chart, K('Mira.png')), document.body);
check('dragging a node off the chart takes it out of the tree', !N('Mira.png'));
check('its row stops being dimmed', !listRow('Mira.png').classList.contains('ch-on-chart'));

// ---------- right-click opens a menu rather than acting straight away ----------
// SillyTavern binds its own contextmenu handlers further up; ours must not reach them.
let ancestorSawContextMenu = 0;
const countContextMenu = () => { ancestorSawContextMenu += 1; };
document.addEventListener('contextmenu', countContextMenu);

const ctxEvent = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
nodeFor(chart, K('Vance.png')).dispatchEvent(ctxEvent);
const menu = document.querySelector('.ch-context-menu');

check('right-clicking a node opens a context menu', !!menu);
check('the browser menu is suppressed', ctxEvent.defaultPrevented);
check('it does not reach handlers further up the tree',
    ancestorSawContextMenu === 0, String(ancestorSawContextMenu));
document.removeEventListener('contextmenu', countContextMenu);
check('right-clicking alone changes nothing', !!N('Vance.png'));
check('the menu names the node',
    menu.querySelector('.ch-context-title')?.textContent === 'House Vance');
check('it sits on the body, clear of the chart pane\'s scrolling',
    menu.parentElement === document.body);

// Living on the body means SillyTavern's "close unpinned drawers on an outside mousedown"
// handler would otherwise shut the very panel the menu belongs to.
let htmlSawPress = 0;
const countPress = () => { htmlSawPress += 1; };
document.documentElement.addEventListener('mousedown', countPress);
menu.querySelector('.ch-context-item').dispatchEvent(
    new dom.window.MouseEvent('mousedown', { bubbles: true }));
check('a press inside the menu does not escape to the page',
    htmlSawPress === 0, String(htmlSawPress));
document.documentElement.removeEventListener('mousedown', countPress);

const menuLabels = [...menu.querySelectorAll('.ch-context-item span')].map((e) => e.textContent);
check('a nested node is offered a detach',
    menuLabels.includes('Detach from parent'), menuLabels.join(' | '));
check('it names the open action for what the node is',
    menuLabels.includes('Open chat'), menuLabels.join(' | '));
check('and keeps the chart settings a separate, differently named entry',
    menuLabels.includes('Settings on this chart'), menuLabels.join(' | '));
check('it offers focus and removal',
    menuLabels.includes('Focus on this line') && menuLabels.includes('Take off the chart'),
    menuLabels.join(' | '));

// dismissals
document.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
check('clicking away dismisses the menu', !document.querySelector('.ch-context-menu'));

nodeFor(chart, K('Vance.png')).dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true }));
document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
check('Escape dismisses the menu', !document.querySelector('.ch-context-menu'));

// a root has nothing to detach from
nodeFor(chart, K('Aldia.png')).dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true }));
check('a root is not offered a detach',
    ![...document.querySelectorAll('.ch-context-item span')].map((e) => e.textContent)
        .includes('Detach from parent'));
document.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));

// and removal still works, from the menu
nodeFor(chart, K('Vance.png')).dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true }));
[...document.querySelectorAll('.ch-context-item')]
    .find((i) => i.textContent.includes('Take off the chart'))
    .dispatchEvent(new dom.window.Event('click'));
check('the menu takes the node off the chart', !N('Vance.png'));
check('its child is lifted to the grandparent', N('Brant.png').parent === K('Aldia.png'));
check('the menu closes after acting', !document.querySelector('.ch-context-menu'));

// ---------- T20: the action strip under the selected node ----------
clickCard(nodeFor(chart, K('Brant.png')));
check('clicking a node opens its editor',
    editor.querySelector('.ch-editor-name')?.textContent === 'Sir Brant',
    editor.querySelector('.ch-editor-name')?.textContent);
check('the clicked node is marked selected',
    nodeFor(chart, K('Brant.png')).classList.contains('ch-node-selected'));

let strip = chart.querySelector('.ch-node-actions');
check('an action strip appears under the selected node', !!strip);
check('it sits directly below that node',
    parseFloat(strip.style.top) === pos('Brant.png')[1] + 108,
    `${strip?.style.top} vs ${pos('Brant.png')[1] + 108}`);
check('a nested node can be detached from the strip', !!strip.querySelector('.fa-link-slash'));
check('the strip carries a focus toggle', !!strip.querySelector('.fa-crosshairs'));
check('it shows as off while focus is off',
    !strip.querySelector('.fa-crosshairs').classList.contains('ch-toggle-on'));

strip.querySelector('.fa-crosshairs').dispatchEvent(new dom.window.Event('click'));
check('the strip toggle turns focus on', S().focusLineage === true);
check('it anchors on the node it belongs to',
    [...chart.querySelectorAll('.ch-node')].map((b) => b.dataset.key).includes(K('Brant.png')));
check('the header toggle follows it',
    document.getElementById('ch_focus').classList.contains('ch-toggle-on'));

strip = chart.querySelector('.ch-node-actions');
check('the strip toggle now shows as on',
    strip.querySelector('.fa-crosshairs').classList.contains('ch-toggle-on'));
strip.querySelector('.fa-crosshairs').dispatchEvent(new dom.window.Event('click'));
check('clicking it again turns focus off', S().focusLineage === false);
check('and the header toggle follows back',
    !document.getElementById('ch_focus').classList.contains('ch-toggle-on'));

strip = chart.querySelector('.ch-node-actions');

// ---------- clicking empty chart space clears the selection ----------
chart.dispatchEvent(pev('pointerdown', 400, 400));
chart.dispatchEvent(pev('pointerup', 400, 400));
check('clicking the chart background deselects', !nodeFor(chart, K('Brant.png'))
    ?.classList.contains('ch-node-selected'));
check('the action strip goes with it', !chart.querySelector('.ch-node-actions'));
check('the editor falls back to its hint', editor.textContent.includes('Click a node'));

// a drag that ends on the backdrop has just re-rooted a node, so it must stay selected
await settleClick();
clickCard(nodeFor(chart, K('Brant.png')));
dragTo(nodeFor(chart, K('Brant.png')), chart);
check('a drag onto the background does not deselect',
    nodeFor(chart, K('Brant.png'))?.classList.contains('ch-node-selected'));
check('and it re-rooted the node', N('Brant.png').parent === null);

// Put Brant back under Aldia; the checks below are about a nested node.
N('Brant.png').parent = K('Aldia.png');
await redraw();
await settleClick();
clickCard(nodeFor(chart, K('Brant.png')));
strip = chart.querySelector('.ch-node-actions');

strip.querySelector('.fa-link-slash').dispatchEvent(new dom.window.Event('click'));
check('detaching makes it a root', N('Brant.png').parent === null);

strip = chart.querySelector('.ch-node-actions');
check('a root has no detach button', !strip.querySelector('.fa-link-slash'));
strip.querySelector('.ch-node-action-remove').dispatchEvent(new dom.window.Event('click'));
check('the strip can take the node off the chart', !N('Brant.png'));
check('and the editor empties with it', editor.textContent.includes('Click a node'));

// ---------- T21: the editor applies live ----------
setTree({ 'Aldia.png': node(null), 'Brant.png': node('Aldia.png') });
await redraw();
await settleClick();
clickCard(nodeFor(chart, K('Brant.png')));

const roleSelect = editor.querySelectorAll('select')[0];
roleSelect.value = 'info';
roleSelect.dispatchEvent(new dom.window.Event('change'));
check('changing the role in the editor saves immediately', N('Brant.png').role === 'info');
check('the node box reflects the new role',
    nodeFor(chart, K('Brant.png')).classList.contains('ch-node-info'));

const booksSelect = editor.querySelector('.ch-books-select');
[...booksSelect.options].find((o) => o.value === 'Shared Book').selected = true;
booksSelect.dispatchEvent(new dom.window.Event('change'));
check('picking a lorebook in the editor saves it to the node',
    N('Brant.png').books.join(',') === 'Shared Book');
check('the node box shows its book count',
    nodeFor(chart, K('Brant.png')).querySelector('.ch-node-books')?.textContent === '1 book');

// ---------- double click opens what the node stands for ----------
// Re-queried between the two clicks: selecting repaints the chart, and a click on the old
// detached element would never reach the document listeners the drag runs on.
const dblClick = (key) => { clickCard(nodeFor(chart, key)); clickCard(nodeFor(chart, key)); };

globalThis.__characterOpened = null;
dblClick(K('Brant.png'));
check('double-clicking a character opens its chat',
    globalThis.__characterOpened === Number(idxOf('Brant.png')),
    String(globalThis.__characterOpened));

// a single click must still just select
globalThis.__characterOpened = null;
await new Promise((resolve) => setTimeout(resolve, 0));
clickCard(nodeFor(chart, K('Aldia.png')));
check('a single click still only selects', globalThis.__characterOpened === null
    && nodeFor(chart, K('Aldia.png')).classList.contains('ch-node-selected'));

// ---------- T22: lorebooks on the chart ----------
S().nodes = {};
await redraw();
await addLorebook('Aldia Lore');
check('a lorebook can be put on the chart', !!S().nodes['book:Aldia Lore'],
    JSON.stringify(Object.keys(S().nodes)));
const bookBox = nodeFor(chart, 'book:Aldia Lore');
check('a lorebook node is drawn with an icon, not a portrait',
    !!bookBox?.querySelector('.ch-node-icon') && !bookBox.querySelector('img'));
check('it is labelled as a lorebook',
    bookBox.querySelector('.ch-node-role').textContent === 'lorebook');
check('a lorebook is always a container', S().nodes['book:Aldia Lore'].role === 'info');

globalThis.__worldInfoOpened = null;
await settleClick();
dblClick('book:Aldia Lore');
check('double-clicking a lorebook opens it in the world info editor',
    globalThis.__worldInfoOpened === 'Aldia Lore', String(globalThis.__worldInfoOpened));

// the same action, reached from the right-click menu
globalThis.__worldInfoOpened = null;
nodeFor(chart, 'book:Aldia Lore').dispatchEvent(
    new dom.window.MouseEvent('contextmenu', { bubbles: true }));
const bookMenuLabels = [...document.querySelectorAll('.ch-context-item span')].map((e) => e.textContent);
check('a lorebook\'s menu names its open action',
    bookMenuLabels.includes('Open in the world info editor'), bookMenuLabels.join(' | '));
[...document.querySelectorAll('.ch-context-item')]
    .find((i) => i.textContent.includes('Open in the world info editor'))
    .dispatchEvent(new dom.window.Event('click'));
check('and opens the book from the menu too',
    globalThis.__worldInfoOpened === 'Aldia Lore', String(globalThis.__worldInfoOpened));

// re-queried: the double click above repainted the chart
dragTo(listRow('Brant.png'), nodeFor(chart, 'book:Aldia Lore'));
check('a character can be nested under a lorebook',
    N('Brant.png').parent === 'book:Aldia Lore');

globalThis.__ctx.characterId = idxOf('Brant.png');
const underBook = await scan();
check('the lorebook node feeds its own book to the character below it',
    underBook.some((e) => e.world === 'Aldia Lore'),
    JSON.stringify([...new Set(underBook.map((e) => e.world))]));

// ---------- T23: personas on the chart ----------
await addPersona('me.png');
check('a persona can be put on the chart', !!S().nodes['persona:me.png']);
const personaBox = nodeFor(chart, 'persona:me.png');
check('a persona node shows its name',
    personaBox.querySelector('.ch-node-name').textContent === 'Traveller');
check('it is labelled as a persona',
    personaBox.querySelector('.ch-node-role').textContent === 'persona');

globalThis.__personaNavigatedTo = null;
// SillyTavern binds the navbar handler to this toggle itself, so count the click rather than
// the drawer opening — the click is the part this extension is responsible for.
let personaToggleClicks = 0;
document.querySelector('#persona-management-button .drawer-toggle')
    .addEventListener('click', () => { personaToggleClicks += 1; });

await settleClick();
dblClick('persona:me.png');
await new Promise((resolve) => setTimeout(resolve, 0)); // the open path awaits

check('double-clicking a persona opens the persona manager at it',
    globalThis.__personaNavigatedTo === 'me.png', String(globalThis.__personaNavigatedTo));

check('and it asked the persona drawer to open', personaToggleClicks === 1,
    String(personaToggleClicks));

globalThis.__personaNavigatedTo = null;
nodeFor(chart, 'persona:me.png').dispatchEvent(
    new dom.window.MouseEvent('contextmenu', { bubbles: true }));
const personaMenuLabels = [...document.querySelectorAll('.ch-context-item span')].map((e) => e.textContent);
check('a persona\'s menu names its open action',
    personaMenuLabels.includes('Open in the persona manager'), personaMenuLabels.join(' | '));
[...document.querySelectorAll('.ch-context-item')]
    .find((i) => i.textContent.includes('Open in the persona manager'))
    .dispatchEvent(new dom.window.Event('click'));
await new Promise((resolve) => setTimeout(resolve, 0));
check('and opens the persona from the menu too',
    globalThis.__personaNavigatedTo === 'me.png', String(globalThis.__personaNavigatedTo));

parentCmd2.callback({ char: 'Sir Brant' }, ''); // detach Brant from the lorebook
S().nodes[K('Brant.png')].parent = 'persona:me.png';
S().nodes['persona:me.png'].includeCardText = true;
await redraw();

const underPersona = await scan();
check('a persona hands down its own lorebook',
    underPersona.some((e) => e.world === 'Shared Book'),
    JSON.stringify([...new Set(underPersona.map((e) => e.world))]));
check('a persona can inject its description',
    underPersona.some((e) => e.world.startsWith('Hierarchy:') && e.content.includes('A wanderer.')),
    JSON.stringify(underPersona.filter((e) => e.world.startsWith('Hierarchy:')).map((e) => e.content)));

// ---------- T24: the editor explains inheritance both ways ----------
clickCard(nodeFor(chart, K('Brant.png')));
await new Promise((resolve) => setTimeout(resolve, 0));
check('the editor lists what the node inherits from above',
    [...editor.querySelectorAll('.ch-inherited-book')].map((e) => e.textContent).includes('Shared Book'),
    [...editor.querySelectorAll('.ch-inherited-book')].map((e) => e.textContent).join(','));

clickCard(nodeFor(chart, 'persona:me.png'));
await new Promise((resolve) => setTimeout(resolve, 0));
check('the editor states what the node passes down',
    editor.textContent.includes('Everything nested under this inherits: Shared Book'),
    [...editor.querySelectorAll('.ch-hint')].map((e) => e.textContent).join(' // '));
check('a persona has no role to choose',
    editor.querySelector('select[disabled], input[disabled]')?.value?.includes('Persona') === true,
    editor.querySelector('input[disabled]')?.value);

// ---------- T25: a node whose target is gone ----------
S().nodes['book:No Such Book'] = node(null);
await redraw();
check('a missing lorebook is still shown',
    nodeFor(chart, 'book:No Such Book')?.classList.contains('ch-node-missing'));
check('a missing node does not break the scan', Array.isArray(await scan()));
delete S().nodes['book:No Such Book'];

// ---------- T26: the pre-types shape is migrated ----------
S().nodes = { 'Brant.png': { parent: 'Vance.png', role: 'actor', books: [], includeCardText: false },
    'Vance.png': { parent: null, role: 'info', books: ['Shared Book'], includeCardText: false } };
await redraw();
check('old bare-avatar keys are rewritten as character keys',
    !!N('Brant.png') && !!N('Vance.png') && !S().nodes['Brant.png'],
    JSON.stringify(Object.keys(S().nodes)));
check('old parent links are rewritten too', N('Brant.png').parent === K('Vance.png'));
check('the migrated tree still inherits',
    (await scan()).some((e) => e.world === 'Shared Book'));

// ---------- T27: export round-trips ----------
document.getElementById('ch_export').dispatchEvent(new dom.window.Event('click'));
const exported = JSON.parse(globalThis.__downloaded.content);
check('export captures the typed tree',
    exported.nodes[K('Brant.png')].parent === K('Vance.png')
    && exported.nodes[K('Vance.png')].books[0] === 'Shared Book',
    globalThis.__downloaded.content);

// ---------- T28: the master switch ----------
S().enabled = false;
check('the master switch stops all injection', (await scan()).length === 0);
S().enabled = true;

// ---------- T29b: the dimming belongs to the panel ----------
setTree({ 'Aldia.png': node(null), 'Vance.png': node('Aldia.png'), 'Brant.png': node('Vance.png') });
await redraw();
const chToggle = drawerButton.querySelector('.drawer-toggle');
const drawerIsOpen = () => drawerContent.classList.contains('openDrawer');
/** The hold and release paths both await doNavbarIconClick, so let the microtasks drain. */
const releaseTick = () => new Promise((resolve) => setTimeout(resolve, 1));

/**
 * SillyTavern binds its own navbar handler to the character list toggle, which the harness
 * does not have, so stand in for it the same way the stub does for ours.
 */
function userTogglesList() {
    const panel = document.getElementById('right-nav-panel');
    const icon = document.getElementById('rightNavDrawerIcon');
    if (panel.classList.contains('openDrawer')) {
        panel.classList.replace('openDrawer', 'closedDrawer');
        icon.classList.replace('openIcon', 'closedIcon');
    } else {
        panel.classList.replace('closedDrawer', 'openDrawer');
        icon.classList.replace('closedIcon', 'openIcon');
    }
}
async function setDrawer(open) {
    if (drawerIsOpen() !== open) {
        chToggle.dispatchEvent(new dom.window.Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

await setDrawer(true);
check('rows on the chart are dimmed while the panel is open',
    listRow('Aldia.png').classList.contains('ch-on-chart'));

await setDrawer(false);
check('closing the panel clears the dimming',
    !charList.querySelector('.ch-on-chart'),
    [...charList.querySelectorAll('.ch-on-chart')].length + ' still dimmed');

// With the chart hidden every release counts as "off the chart", which would remove things.
dragTo(listRow('Aldia.png'), document.body);
check('a list drag does nothing while the panel is shut', !!N('Aldia.png'));

await setDrawer(true);
check('reopening the panel brings the dimming back',
    listRow('Aldia.png').classList.contains('ch-on-chart'));

// ---------- T29b2: the character list comes along for the ride ----------
const listPanel = document.getElementById('right-nav-panel');
const listIcon = document.getElementById('rightNavDrawerIcon');
const listOpen = () => listPanel.classList.contains('openDrawer');

// Our drawer is open from the block above; close it so the list state is ours to set.
await setDrawer(false);
await releaseTick();
check('the character list starts closed', !listOpen());

await setDrawer(true);
check('opening the chart brings the character list up with it', listOpen());
check('and the chart stays open beside it', drawerIsOpen());
check('the list is pinned for the moment, or opening ours would shut it',
    listPanel.classList.contains('pinnedOpen') && listIcon.classList.contains('drawerPinnedOpen'));

// The list sits above the panel on the right, so the panel's right edge has to come in by
// however wide the list is, or the two overlap. jsdom has no layout, so the measurement is
// stubbed to something non-zero.
listPanel.getBoundingClientRect = () => ({ width: 320, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 });
await redraw();
check('the panel is held clear of the character list',
    drawerContent.classList.contains('ch-beside-list'));
check('by exactly the width the list is taking',
    drawerContent.style.getPropertyValue('--ch-list-width') === '320px',
    drawerContent.style.getPropertyValue('--ch-list-width'));

await setDrawer(false);
await releaseTick();
check('closing the chart puts the list back', !listOpen());
check('and the panel is no longer held clear of it',
    !drawerContent.classList.contains('ch-beside-list'));
check('and takes the temporary pin off again',
    !listPanel.classList.contains('pinnedOpen') && !listIcon.classList.contains('drawerPinnedOpen'));

// A list the user opened themselves must be left alone.
userTogglesList();
check('the user can open the list on their own', listOpen());
await setDrawer(true);
await setDrawer(false);
await releaseTick();
check('closing the chart leaves a list the user opened', listOpen(),
    'the extension shut a list it did not open');

// Throwing the lock while the chart is open is a newer decision than our hold.
const listLock = document.getElementById('rm_button_panel_pin');
await setDrawer(true);
check('the list came up for the lock check', listOpen());

// what SillyTavern's lock handler does
listLock.checked = true;
listPanel.classList.add('pinnedOpen');
listIcon.classList.add('drawerPinnedOpen');

await setDrawer(false);
await releaseTick();
check('locking the list while the chart is open keeps it open afterwards', listOpen(),
    'the extension closed a list the user had locked');
check('and leaves the lock in place',
    listPanel.classList.contains('pinnedOpen') && listIcon.classList.contains('drawerPinnedOpen'));

// unlocking puts things back the way SillyTavern would
listLock.checked = false;
listPanel.classList.remove('pinnedOpen');
listIcon.classList.remove('drawerPinnedOpen');
userTogglesList();
check('the list can be closed again once unlocked', !listOpen());

// Leave it open again: the checks below start from a list the user has up.
userTogglesList();

// A pin the user set must survive too.
listPanel.classList.add('pinnedOpen');
listIcon.classList.add('drawerPinnedOpen');
await setDrawer(true);
await setDrawer(false);
await releaseTick();
check('a pin the user set is not removed',
    listPanel.classList.contains('pinnedOpen') && listIcon.classList.contains('drawerPinnedOpen'));
listPanel.classList.remove('pinnedOpen');
listIcon.classList.remove('drawerPinnedOpen');
userTogglesList();

// Another drawer opening closes ours by swapping the classes, never touching our toggle.
await setDrawer(true);
setTree({ 'Aldia.png': node(null), 'Brant.png': node('Aldia.png') });
await redraw();
check('the list came up again', listOpen());
check('and rows on the chart are dimmed', !!charList.querySelector('.ch-on-chart'));

drawerContent.classList.replace('openDrawer', 'closedDrawer'); // what doNavbarIconClick does
await releaseTick();
check('a drawer opening elsewhere still releases the list', !listOpen());
check('and clears the dimming it left behind',
    !charList.querySelector('.ch-on-chart'),
    [...charList.querySelectorAll('.ch-on-chart')].length + ' rows still dimmed');

// and back in again the same way
drawerContent.classList.replace('closedDrawer', 'openDrawer');
await releaseTick();
check('reopening by class alone repaints the chart',
    chart.querySelectorAll('.ch-node').length === 2,
    String(chart.querySelectorAll('.ch-node').length));
check('and the dimming comes back', !!charList.querySelector('.ch-on-chart'));

await setDrawer(true);

// ---------- T29c: focusing on one line ----------
setTree({
    'Aldia.png': node(null),
    'Vance.png': node('Aldia.png'),
    'Brant.png': node('Vance.png'),
    'Mira.png': node('Aldia.png'),   // a side branch off the shared ancestor
    'Weather.png': node(null),       // a separate root entirely
});
await redraw();
const drawn = () => [...chart.querySelectorAll('.ch-node')].map((b) => b.dataset.key).sort();

check('with focus off, every tree is drawn', drawn().length === 5, JSON.stringify(drawn()));

clickCard(nodeFor(chart, K('Vance.png')));
document.getElementById('ch_focus').dispatchEvent(new dom.window.Event('click'));

check('the focus toggle is remembered', S().focusLineage === true);
check('the toggle shows as on',
    document.getElementById('ch_focus').classList.contains('ch-toggle-on'));
check('focus keeps the selected node, its ancestors and its descendants',
    JSON.stringify(drawn()) === JSON.stringify([K('Aldia.png'), K('Brant.png'), K('Vance.png')].sort()),
    JSON.stringify(drawn()));
check('a separate root is hidden', !nodeFor(chart, K('Weather.png')));
check('a side branch off a shared ancestor is hidden', !nodeFor(chart, K('Mira.png')));
check('the chart says what it is hiding',
    chart.querySelector('.ch-focus-note')?.textContent.includes('2 other nodes are hidden'),
    chart.querySelector('.ch-focus-note')?.textContent);
check('connectors only join what is drawn',
    chart.querySelectorAll('path.ch-link').length === 2,
    String(chart.querySelectorAll('path.ch-link').length));

// selecting a leaf narrows it to that single line
clickCard(nodeFor(chart, K('Brant.png')));
check('focusing a leaf drops the branches below the selection',
    JSON.stringify(drawn()) === JSON.stringify([K('Aldia.png'), K('Brant.png'), K('Vance.png')].sort()),
    JSON.stringify(drawn()));

document.getElementById('ch_focus').dispatchEvent(new dom.window.Event('click'));
check('turning focus off brings everything back', drawn().length === 5, JSON.stringify(drawn()));
check('the toggle shows as off',
    !document.getElementById('ch_focus').classList.contains('ch-toggle-on'));

// ---------- T30: the tri-state character list filter ----------
const { entitiesFilter } = await import(path.join(TMP, 'public/script.js'));
const filterRow = document.querySelector('#rm_characters_block .rm_tag_filter');
const filterButton = document.getElementById('character_hierarchy_filter');

check('a filter button is added to the character list filter row',
    !!filterButton && filterButton.parentElement === filterRow);
check('it sits ahead of the tag management buttons',
    filterButton?.nextElementSibling?.classList.contains('manageTags'));
check('it is shaped like SillyTavern\'s own actionable filter tags',
    filterButton.classList.contains('tag') && filterButton.classList.contains('actionable')
    && !!filterButton.querySelector('.tag_name.fa-sitemap'));
check('it starts in the off state',
    filterButton.dataset.toggleState === 'UNDEFINED'
    && filterButton.classList.contains('undefined'),
    filterButton.dataset.toggleState);

// the tree for the filter checks: Vance and Brant are nested, Mira and Aldia are not
setTree({ 'Vance.png': node(null), 'Brant.png': node('Vance.png') });
const entities = CHARACTERS.map((c, id) => ({ item: c, id, type: 'character' }));
entities.push({ item: { name: 'a folder' }, id: 'f', type: 'tag' });
const visible = () => entitiesFilter.applyFilters(entities)
    .filter((e) => e.type === 'character').map((e) => e.item.avatar).sort();

check('with the filter off, every card is listed',
    visible().length === CHARACTERS.length, String(visible().length));

filterButton.dispatchEvent(new dom.window.Event('click'));
check('one click selects "only in a hierarchy"',
    filterButton.dataset.toggleState === 'SELECTED' && filterButton.classList.contains('selected'));
check('only the nested cards are listed',
    JSON.stringify(visible()) === JSON.stringify(['Brant.png', 'Vance.png']), JSON.stringify(visible()));
check('folders survive the filter',
    entitiesFilter.applyFilters(entities).some((e) => e.type === 'tag'));

filterButton.dispatchEvent(new dom.window.Event('click'));
check('a second click excludes them',
    filterButton.dataset.toggleState === 'EXCLUDED' && filterButton.classList.contains('excluded'));
check('the nested cards are hidden and the rest remain',
    !visible().includes('Brant.png') && !visible().includes('Vance.png')
    && visible().includes('Mira.png'), JSON.stringify(visible()));

filterButton.dispatchEvent(new dom.window.Event('click'));
check('a third click returns to off', filterButton.dataset.toggleState === 'UNDEFINED');
check('the choice is remembered in settings', S().listFilterState === 'UNDEFINED');
check('the cycle matches SillyTavern\'s own tri-state order',
    JSON.stringify(Object.keys(FILTER_STATES_ORDER)) === '["SELECTED","EXCLUDED","UNDEFINED"]');

// ---------- T31: the filter follows tree edits, without looping ----------
filterButton.dispatchEvent(new dom.window.Event('click')); // back to SELECTED
globalThis.__listRepaints = 0;
parentCmd2.callback({ char: 'Mira' }, 'House Vance'); // a tree edit, which calls save()
check('editing the tree repaints the filtered character list',
    globalThis.__listRepaints > 0, String(globalThis.__listRepaints));
check('the newly nested card appears under the filter',
    visible().includes('Mira.png'), JSON.stringify(visible()));

// a repaint emits CHARACTER_PAGE_LOADED, which the extension listens to; make sure that
// round trip cannot drive the filter into an endless repaint loop
globalThis.__listRepaints = 0;
await redraw();
check('a list repaint does not feed back into another repaint',
    globalThis.__listRepaints === 0, String(globalThis.__listRepaints));

filterButton.dispatchEvent(new dom.window.Event('click'));
filterButton.dispatchEvent(new dom.window.Event('click')); // back to off
globalThis.__listRepaints = 0;
parentCmd2.callback({ char: 'Mira' }, '');
check('with the filter off, tree edits do not touch the character list',
    globalThis.__listRepaints === 0, String(globalThis.__listRepaints));

// ---------- T32: the button survives the row being re-rendered ----------
filterRow.innerHTML = '<span class="tag actionable manageTags"></span>';
await new Promise((resolve) => setTimeout(resolve, 0));
check('the button is restored when SillyTavern rebuilds the filter row',
    !!document.getElementById('character_hierarchy_filter'));
check('and is not duplicated',
    document.querySelectorAll('#character_hierarchy_filter').length === 1,
    String(document.querySelectorAll('#character_hierarchy_filter').length));

await ext.init(); // idempotent
check('only one settings panel exists after a second init()',
    document.querySelectorAll('#character_hierarchy_settings').length === 1);

// ---------- T33: the feature does not depend on the interface ----------
// A fresh load into a page with no top bar: the panel cannot be built, but inheritance is
// the point of the extension and must still run.
{
    const bare = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
    const savedDoc = globalThis.document;
    globalThis.document = bare.window.document;

    const bareHandlers = new Map();
    const bareSource = {
        on(event, cb) { if (!bareHandlers.has(event)) bareHandlers.set(event, []); bareHandlers.get(event).push(cb); },
        async emit(event, ...args) { for (const cb of bareHandlers.get(event) ?? []) await cb(...args); },
    };
    const bareCommands = new Map();
    globalThis.__ctx = { ...globalThis.__ctx, eventSource: bareSource,
        SlashCommandParser: { addCommandObject: (c) => bareCommands.set(c.name, c) } };

    const headless = await import(path.join(EXT_DIR, 'index.js') + '?bare');
    await headless.init();

    check('a missing top bar does not stop the world info listener',
        bareHandlers.has(eventTypes.WORLDINFO_ENTRIES_LOADED));
    check('a missing top bar does not stop the slash commands',
        bareCommands.has('hierarchy-chain'), [...bareCommands.keys()].join(','));

    globalThis.document = savedDoc;

    // That run logs a top bar error on purpose; keep it out of the unexpected-errors report.
    errors.splice(0, errors.length,
        ...errors.filter((e) => !e.includes('no #top-settings-holder')));
}

console.warn = origWarn;
console.error = origError;

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
}
const unexpected = errors.filter((e) => !e.includes('expected'));
if (unexpected.length) {
    console.log('\nconsole.error output during the run:');
    for (const e of unexpected) console.log('  ! ' + e);
}
process.exit(failures.length ? 1 : 0);
