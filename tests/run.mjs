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
import { cpSync, mkdirSync, rmSync } from 'node:fs';
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
    <div id="top-settings-holder"><div id="WI-SP-button" class="drawer"></div></div><div id="extensions_settings2"></div><div id="rm_characters_block"><div class="tags rm_tag_filter"><span class="tag actionable manageTags"></span></div></div>
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
    'DocumentFragment', 'Event', 'CustomEvent', 'File', 'MutationObserver']) {
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
    powerUserSettings: {},
    eventSource,
    eventTypes,
    saveSettingsDebounced: () => {},
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
function setTree(nodes) { S().nodes = structuredClone(nodes); }
const node = (parent, extra = {}) => ({ parent, role: 'actor', books: [], includeCardText: false, ...extra });

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
check('chart and tray containers exist',
    !!document.getElementById('ch_chart') && !!document.getElementById('ch_tray')
    && !!document.getElementById('ch_editor'));
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
    !!drawerContent?.querySelector('#ch_chart') && !!drawerContent?.querySelector('#ch_tray')
    && !!drawerContent?.querySelector('#ch_editor') && !!drawerContent?.querySelector('#ch_enabled'));
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
check('the Extensions pointer opens the drawer', drawerContent.classList.contains('openDrawer'));
check('the icon flips to open',
    !!drawerButton.querySelector('.drawer-icon.openIcon'));
check('opening the drawer paints the chart',
    document.getElementById('ch_chart').children.length > 0,
    String(document.getElementById('ch_chart').children.length));

// ---------- T3: ancestors contribute, speaker's own and global books do not ----------
wi.setGlobalBooks(['Global Book']);
setTree({ 'Brant.png': node(null), 'Vance.png': node('Aldia.png'), 'Aldia.png': node(null) });
S().nodes['Brant.png'].parent = 'Vance.png';
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
globalThis.__ctx.powerUserSettings = { persona_description_lorebook: 'Vance Secrets' };
entries = await scan();
check('skips a book the persona already scans', !entries.some((e) => e.world === 'Vance Secrets'));
globalThis.__ctx.powerUserSettings = {};

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
    S().nodes['Aldia.png'].parent === null, String(S().nodes['Aldia.png'].parent));

// a loop smuggled in by hand must not hang the scan
S().nodes['Aldia.png'].parent = 'Brant.png';
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
    && S().nodes['Brant.png'].role === 'info');
check('/hierarchy-role rejects nonsense',
    commands.get('hierarchy-role').callback({ char: 'Sir Brant' }, 'banana') === 'info');
check('/hierarchy-parent reads a parent',
    commands.get('hierarchy-parent').callback({ char: 'Sir Brant' }) === 'House Vance');
check('/hierarchy-parent detaches on an empty value',
    commands.get('hierarchy-parent').callback({ char: 'Kingdom of Aldia' }, '') === '');
const booksOut = await commands.get('hierarchy-books').callback({ char: 'Sir Brant' });
check('/hierarchy-books lists inherited books',
    booksOut.includes('Vance Secrets') && booksOut.includes('Aldia Lore'), booksOut);

// ---------- T15: the org chart ----------
S().nodes = {};
await redraw();
const chart = document.getElementById('ch_chart');
const tray = document.getElementById('ch_tray');
const editor = document.getElementById('ch_editor');
const parentCmd2 = commands.get('hierarchy-parent');

const pev = (type, x, y) => new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
const nodesIn = (root) => [...root.querySelectorAll('.ch-node')];
const nodeFor = (root, avatar) => nodesIn(root).find((n) => n.dataset.avatar === avatar);

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

check('an empty chart invites a drag', chart.textContent.includes('Drag a card in'));
check('the tray lists every card while the tree is empty', nodesIn(tray).length === CHARACTERS.length,
    String(nodesIn(tray).length));
check('the tray count is shown', document.getElementById('ch_tray_count').textContent === String(CHARACTERS.length));
check('tray cards show their avatar image',
    nodeFor(tray, 'Brant.png').querySelector('.ch-node-avatar')?.getAttribute('src')
        ?.includes('file=Brant.png'),
    nodeFor(tray, 'Brant.png').querySelector('.ch-node-avatar')?.getAttribute('src'));
check('tray cards show the character name',
    nodeFor(tray, 'Brant.png').querySelector('.ch-node-name').textContent === 'Sir Brant');

// ---------- T16: tray filter ----------
const trayFilter = document.getElementById('ch_tray_filter');
trayFilter.value = 'mira';
trayFilter.dispatchEvent(new dom.window.Event('input'));
check('the tray filter narrows the list', nodesIn(tray).length === 1
    && nodeFor(tray, 'Mira.png'), String(nodesIn(tray).length));
trayFilter.value = '';
trayFilter.dispatchEvent(new dom.window.Event('input'));

// ---------- T17: dragging out of the tray and onto a parent ----------
dragTo(nodeFor(tray, 'Aldia.png'), chart);
check('dropping a tray card on empty chart space makes it a root',
    S().nodes['Aldia.png']?.parent === null && nodesIn(chart).length === 1,
    JSON.stringify(Object.keys(S().nodes)));
check('a card in the chart leaves the tray', !nodeFor(tray, 'Aldia.png'));

dragTo(nodeFor(tray, 'Vance.png'), nodeFor(chart, 'Aldia.png'));
check('dropping a tray card on a chart card nests it',
    S().nodes['Vance.png']?.parent === 'Aldia.png', JSON.stringify(S().nodes['Vance.png']));

dragTo(nodeFor(tray, 'Brant.png'), nodeFor(chart, 'Vance.png'));
dragTo(nodeFor(tray, 'Mira.png'), nodeFor(chart, 'Vance.png'));
check('two cards can share a parent',
    S().nodes['Brant.png'].parent === 'Vance.png' && S().nodes['Mira.png'].parent === 'Vance.png');

// ---------- T18: layout ----------
const pos = (avatar) => {
    const n = nodeFor(chart, avatar);
    return [parseFloat(n.style.left), parseFloat(n.style.top)];
};
check('each level sits one row lower',
    pos('Aldia.png')[1] === 0 && pos('Vance.png')[1] === 156 && pos('Brant.png')[1] === 312,
    JSON.stringify([pos('Aldia.png')[1], pos('Vance.png')[1], pos('Brant.png')[1]]));
check('siblings sit in adjacent columns',
    Math.abs(pos('Mira.png')[0] - pos('Brant.png')[0]) === 134,
    String(Math.abs(pos('Mira.png')[0] - pos('Brant.png')[0])));
check('a parent is centred over its children',
    pos('Vance.png')[0] === (pos('Brant.png')[0] + pos('Mira.png')[0]) / 2,
    `${pos('Vance.png')[0]} vs ${(pos('Brant.png')[0] + pos('Mira.png')[0]) / 2}`);
// Aldia over Vance over {Brant, Mira}: widest leaf at x=134, so 134 + 116 wide and
// 3 rows + 2 gaps tall, plus 14px of padding on each side.
check('the chart box includes its own padding, so a small tree never scrolls',
    chart.style.width === '278px' && chart.style.height === '448px',
    `${chart.style.width} x ${chart.style.height}`);
check('the padding is published to CSS from the one place it is defined',
    chart.style.getPropertyValue('--ch-pad') === '14px',
    chart.style.getPropertyValue('--ch-pad'));

check('one connector per parent-child link',
    chart.querySelectorAll('svg.ch-links path.ch-link').length === 3,
    String(chart.querySelectorAll('svg.ch-links path.ch-link').length));
check('a connector is an elbow from parent bottom to child top',
    /^M [\d.]+ 108 V 132 H [\d.]+ V 156$/.test(
        [...chart.querySelectorAll('path.ch-link')].map((p) => p.getAttribute('d'))
            .find((d) => d.includes('V 156')) ?? ''),
    [...chart.querySelectorAll('path.ch-link')].map((p) => p.getAttribute('d')).join(' | '));

// ---------- T19: a drop that would close a loop is refused ----------
dragTo(nodeFor(chart, 'Aldia.png'), nodeFor(chart, 'Brant.png'));
check('dropping a card onto its own descendant is refused',
    S().nodes['Aldia.png'].parent === null, String(S().nodes['Aldia.png'].parent));
check('the refused drop left the tree untouched',
    S().nodes['Brant.png'].parent === 'Vance.png');

// ---------- T20: dragging back to the tray ----------
dragTo(nodeFor(chart, 'Mira.png'), tray);
check('dropping a card on the tray takes it out of the tree', !S().nodes['Mira.png']);
check('the card reappears in the tray', !!nodeFor(tray, 'Mira.png'));

dragTo(nodeFor(chart, 'Vance.png'), tray);
check('removing a middle card lifts its child to the grandparent',
    !S().nodes['Vance.png'] && S().nodes['Brant.png'].parent === 'Aldia.png',
    JSON.stringify(S().nodes));

// ---------- T21: promoting a nested card to a root ----------
dragTo(nodeFor(chart, 'Brant.png'), chart);
check('dropping a nested card on empty chart space promotes it to a root',
    S().nodes['Brant.png'].parent === null);

// ---------- T22: clicking a card opens the editor under the chart ----------
check('the editor starts with a hint', editor.textContent.includes('Click a card'));
clickCard(nodeFor(chart, 'Brant.png'));
check('clicking a card opens its editor',
    editor.querySelector('.ch-editor-name')?.textContent === 'Sir Brant',
    editor.querySelector('.ch-editor-name')?.textContent);
check('the clicked card is marked selected',
    nodeFor(chart, 'Brant.png').classList.contains('ch-node-selected'));
check('the editor offers a role control', !!editor.querySelector('select'));
check('a click did not move the card', S().nodes['Brant.png'].parent === null);

// ---------- T23: the editor applies live ----------
const roleSelect = editor.querySelectorAll('select')[0];
roleSelect.value = 'info';
roleSelect.dispatchEvent(new dom.window.Event('change'));
check('changing the role in the editor saves immediately', S().nodes['Brant.png'].role === 'info');
check('the card box reflects the new role',
    nodeFor(chart, 'Brant.png').classList.contains('ch-node-info')
    && nodeFor(chart, 'Brant.png').querySelector('.ch-node-role').textContent === 'informational');

const parentSelect = editor.querySelectorAll('select')[1];
parentSelect.value = 'Aldia.png';
parentSelect.dispatchEvent(new dom.window.Event('change'));
check('changing the parent in the editor re-nests the card',
    S().nodes['Brant.png'].parent === 'Aldia.png');

const booksSelect = editor.querySelector('.ch-books-select');
[...booksSelect.options].find((o) => o.value === 'Shared Book').selected = true;
booksSelect.dispatchEvent(new dom.window.Event('change'));
check('picking a lorebook in the editor saves it to the card',
    S().nodes['Brant.png'].books.join(',') === 'Shared Book', JSON.stringify(S().nodes['Brant.png'].books));
check('the card box shows its book count',
    nodeFor(chart, 'Brant.png').querySelector('.ch-node-books')?.textContent === '1 book');

// ---------- T24: the editor explains inheritance both ways ----------
S().nodes = {
    'Aldia.png': node(null, { role: 'info', books: ['Shared Book'] }),
    'Brant.png': node('Aldia.png'),
};
await redraw();
parentCmd2.callback({ char: 'Sir Brant' }, 'Kingdom of Aldia'); // re-nests and redraws
clickCard(nodeFor(chart, 'Brant.png'));
await new Promise((resolve) => setTimeout(resolve, 0)); // the read-outs fill in asynchronously
check('the editor lists what the card inherits from above',
    [...editor.querySelectorAll('.ch-inherited-book')].map((e) => e.textContent).includes('Shared Book'),
    [...editor.querySelectorAll('.ch-inherited-book')].map((e) => e.textContent).join(','));
check('the inherited row names the card it came from',
    editor.querySelector('.ch-inherited-from')?.textContent.includes('Kingdom of Aldia'),
    editor.querySelector('.ch-inherited-from')?.textContent);

clickCard(nodeFor(chart, 'Aldia.png'));
await new Promise((resolve) => setTimeout(resolve, 0));
check('the editor states which books the card passes down to its children',
    // Aldia Lore is the card's own "Character Lore"; Shared Book is attached here.
    editor.textContent.includes('Everything nested under this card inherits: Aldia Lore, Shared Book'),
    [...editor.querySelectorAll('.ch-hint')].map((e) => e.textContent).join(' // '));

// ---------- T25: a parent's own books really do reach the children ----------
globalThis.__ctx.characterId = idxOf('Brant.png');
const inheritedEntries = await scan();
check('a book attached to the parent card is scanned for the child',
    inheritedEntries.some((e) => e.world === 'Shared Book'),
    JSON.stringify([...new Set(inheritedEntries.map((e) => e.world))]));

// ---------- T26: a card that is no longer installed ----------
S().nodes['Ghost.png'] = node(null);
parentCmd2.callback({ char: 'Sir Brant' }, 'Kingdom of Aldia');
check('a missing card is still shown in the chart',
    nodeFor(chart, 'Ghost.png')?.classList.contains('ch-node-missing'));
check('a missing card does not break the scan', Array.isArray(await scan()));
delete S().nodes['Ghost.png'];

// ---------- T27: export round-trips ----------
S().nodes = {
    'Brant.png': node('Vance.png'),
    'Vance.png': node(null, { role: 'info', books: ['Shared Book'] }),
};
document.getElementById('ch_export').dispatchEvent(new dom.window.Event('click'));
const exported = JSON.parse(globalThis.__downloaded.content);
check('export captures the tree',
    exported.nodes['Brant.png'].parent === 'Vance.png'
    && exported.nodes['Vance.png'].role === 'info'
    && exported.nodes['Vance.png'].books[0] === 'Shared Book',
    globalThis.__downloaded.content);

// ---------- T28: the master switch ----------
S().enabled = false;
check('the master switch stops all injection', (await scan()).length === 0);
S().enabled = true;

// ---------- T29: the character panel button opens the panel on that card ----------
S().nodes = { 'Vance.png': node(null), 'Brant.png': node('Vance.png') };

// Close the drawer so the character panel button has to reopen it.
drawerButton.querySelector('.drawer-toggle').dispatchEvent(new dom.window.Event('click'));
check('the drawer can be closed again', drawerContent.classList.contains('closedDrawer'));

globalThis.__ctx.characterId = idxOf('Brant.png');
document.getElementById('character_hierarchy_button').dispatchEvent(new dom.window.Event('click'));
check('the character panel button reopens the drawer', drawerContent.classList.contains('openDrawer'));
check('it selects the open character',
    editor.querySelector('.ch-editor-name')?.textContent === 'Sir Brant',
    editor.querySelector('.ch-editor-name')?.textContent);

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
S().nodes = { 'Vance.png': node(null), 'Brant.png': node('Vance.png') };
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
