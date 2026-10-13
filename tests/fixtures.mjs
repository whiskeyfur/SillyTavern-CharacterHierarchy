/**
 * Checks that the demo set in ../fixtures produces the inheritance its README promises.
 *
 * Reads the shipped lorebooks, character cards and hierarchy.json, then drives the real
 * extension over them so the demo set cannot drift away from the documentation.
 *
 *   npm install && npm run test:fixtures
 */
import { JSDOM } from 'jsdom';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..');
const FIXTURES = path.join(REPO, 'fixtures');

const TMP = path.join(HERE, '.tmp-fixtures');
const SCRIPTS = path.join(TMP, 'public/scripts');
const EXT_DIR = path.join(SCRIPTS, 'extensions/third-party/CH');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(EXT_DIR, { recursive: true });
cpSync(path.join(HERE, 'stubs/public'), path.join(TMP, 'public'), { recursive: true });
cpSync(path.join(REPO, 'index.js'), path.join(EXT_DIR, 'index.js'));
globalThis.__templateDir = REPO;

globalThis.__books = {};
for (const file of readdirSync(path.join(FIXTURES, 'worlds'))) {
    globalThis.__books[file.replace(/\.json$/, '')] =
        JSON.parse(readFileSync(path.join(FIXTURES, 'worlds', file), 'utf-8'));
}

const CHARACTERS = readdirSync(path.join(FIXTURES, 'characters'))
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
        const card = JSON.parse(readFileSync(path.join(FIXTURES, 'characters', file), 'utf-8'));
        return {
            avatar: file.replace(/\.json$/, '.png'),
            name: card.data.name,
            description: card.data.description,
            personality: card.data.personality,
            scenario: card.data.scenario,
            data: card.data,
        };
    });

const dom = new JSDOM('<!doctype html><html><body><div id="top-settings-holder"><div id="WI-SP-button" class="drawer"></div></div><div id="extensions_settings2"></div><div id="rm_characters_block"><div class="tags rm_tag_filter"><span class="tag actionable manageTags"></span></div></div>'
    + '<div id="avatar_controls"><div class="form_create_bottom_buttons_block">'
    + '<div id="world_button"></div></div></div></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLInputElement',
    'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLOptionElement', 'Node',
    'DocumentFragment', 'Event', 'CustomEvent', 'File', 'MutationObserver']) {
    globalThis[key] = key === 'window' ? dom.window : dom.window[key];
}
globalThis.toastr = { info: () => {}, success: () => {}, warning: () => {}, error: () => {} };
// index.js uses jQuery only to hand elements to SillyTavern helpers; a thin wrapper is enough.
globalThis.jQuery = (arg) => (typeof arg === 'function' ? undefined : Object.assign([arg], { 0: arg }));
globalThis.$ = globalThis.jQuery;

const handlers = new Map();
const eventSource = {
    on(event, cb) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(cb); },
    async emit(event, ...args) { for (const cb of handlers.get(event) ?? []) await cb(...args); },
};
const eventTypes = { WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded', CHAT_CHANGED: 'chat_id_changed' };
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
    unshallowCharacter: async () => {},
    getThumbnailUrl: (type, file) => `/thumbnail?type=${type}&file=${file}`,
    getWorldInfoNames: () => Object.keys(globalThis.__books),
    SlashCommandParser: { addCommandObject: (command) => commands.set(command.name, command) },
    SlashCommand: { fromProps: (props) => props },
    SlashCommandNamedArgument: { fromProps: (props) => props },
    ARGUMENT_TYPE: { STRING: 'string' },
};

const { extension_settings } = await import(path.join(SCRIPTS, 'extensions.js'));
const ext = await import(path.join(EXT_DIR, 'index.js'));
await ext.init();

const shipped = JSON.parse(readFileSync(path.join(FIXTURES, 'hierarchy.json'), 'utf-8'));
extension_settings.characterHierarchy.nodes = shipped.nodes;

async function scanAs(avatar) {
    globalThis.__ctx.characterId = String(CHARACTERS.findIndex((c) => c.avatar === avatar));
    const payload = { globalLore: [], characterLore: [], chatLore: [], personaLore: [] };
    await eventSource.emit(eventTypes.WORLDINFO_ENTRIES_LOADED, payload);
    return payload.characterLore;
}

const booksIn = (entries) => [...new Set(entries
    .filter((e) => !e.world.startsWith('Hierarchy:')).map((e) => e.world))].sort();
const cardTextIn = (entries) => [...new Set(entries
    .filter((e) => e.world.startsWith('Hierarchy:')).map((e) => e.world))].sort();

let pass = 0;
const failures = [];
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

console.log(`\n${CHARACTERS.length} cards, ${Object.keys(globalThis.__books).length} lorebooks, `
    + `${Object.keys(shipped.nodes).length} nodes\n`);

for (const person of ['Peter', 'Paul', 'Mary']) {
    const entries = await scanAs(`${person}.png`);
    const books = booksIn(entries);

    console.log(`${person}: ${books.join(', ')} + ${cardTextIn(entries).length} card texts `
        + `= ${entries.length} entries`);

    check(`${person} inherits Earth, North America and USA`,
        JSON.stringify(books) === JSON.stringify(['Earth', 'North America', 'USA']), JSON.stringify(books));
    check(`${person}'s own book is not pulled in twice`, !books.includes(person));
    check(`${person} does not inherit a sibling's book`,
        !books.some((book) => ['Peter', 'Paul', 'Mary'].includes(book)), JSON.stringify(books));
    check(`${person} inherits card text from all three informational ancestors`,
        cardTextIn(entries).length === 3, JSON.stringify(cardTextIn(entries)));
}

const peter = await scanAs('Peter.png');
const keyed = (key) => peter.find((entry) => Array.isArray(entry.key) && entry.key.includes(key));
check('an Earth-tier key answers for Peter', keyed('gravity')?.world === 'Earth');
check('a North America-tier key answers for Peter', keyed('prairie')?.world === 'North America');
check('a USA-tier key answers for Peter', keyed('dollar')?.world === 'USA');
check('the USA card text is injected as an always-on entry',
    peter.some((e) => e.world === 'Hierarchy: USA' && e.constant === true
        && e.content.includes('federal republic')));

check('USA inherits only what is above it',
    JSON.stringify(booksIn(await scanAs('USA.png'))) === JSON.stringify(['Earth', 'North America']));
check('Earth, at the root, inherits nothing', (await scanAs('Earth.png')).length === 0);
check('/hierarchy-chain reports Peter\'s full path',
    commands.get('hierarchy-chain').callback({ char: 'Peter' }) === 'USA, North America, Earth',
    commands.get('hierarchy-chain').callback({ char: 'Peter' }));

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const failure of failures) console.log('  - ' + failure);
process.exit(failures.length ? 1 : 0);
