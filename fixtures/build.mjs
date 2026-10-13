/**
 * Builds an importable demo set for the Character Hierarchy extension:
 *
 *   Earth  ->  North America  ->  USA  ->  Peter, Paul, Mary
 *
 * Each card gets its own lorebook, keyed so you can see which tier answered. Ask about
 * gravity and Earth's book replies; ask about the dollar and the USA's does; ask Peter about
 * his boat and his own does. None of the three people carry the upper books themselves.
 *
 * Run with: node build.mjs
 */
import { Buffer } from 'node:buffer';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const HERE = path.dirname(new URL(import.meta.url).pathname);

// ---------------------------------------------------------------- PNG writing

/** @returns {Buffer} A length-type-data-crc PNG chunk. */
function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
}

/** @returns {Buffer} A tEXt chunk holding base64 character data. */
function textChunk(keyword, text) {
    return chunk('tEXt', Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        Buffer.from(text, 'latin1'),
    ]));
}

/**
 * A solid-colour avatar with the character card embedded the way SillyTavern does it:
 * base64 JSON in a `chara` tEXt chunk, plus a `ccv3` chunk for V3 readers.
 */
function cardPng(size, [r, g, b], card) {
    const stride = size * 3 + 1;
    const raw = Buffer.alloc(stride * size);
    for (let y = 0; y < size; y++) {
        const row = y * stride;
        raw[row] = 0; // filter: none
        for (let x = 0; x < size; x++) {
            // a soft vertical gradient so the avatars are not completely flat
            const shade = 1 - (y / size) * 0.35;
            raw[row + 1 + x * 3] = Math.round(r * shade);
            raw[row + 2 + x * 3] = Math.round(g * shade);
            raw[row + 3 + x * 3] = Math.round(b * shade);
        }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: truecolour

    const v2 = JSON.stringify(card);
    const v3 = JSON.stringify({ ...card, spec: 'chara_card_v3', spec_version: '3.0' });

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        textChunk('chara', Buffer.from(v2, 'utf8').toString('base64')),
        textChunk('ccv3', Buffer.from(v3, 'utf8').toString('base64')),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ---------------------------------------------------------------- world info

const ENTRY_DEFAULTS = {
    keysecondary: [],
    constant: false,
    selective: true,
    order: 100,
    position: 0,
    disable: false,
    addMemo: true,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    probability: 100,
    depth: 4,
    useProbability: true,
    role: null,
    vectorized: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
};

/** @returns {object} A lorebook in SillyTavern's on-disk shape. */
function lorebook(entries) {
    return {
        entries: Object.fromEntries(entries.map((entry, index) => [index, {
            uid: index,
            ...ENTRY_DEFAULTS,
            ...entry,
            displayIndex: index,
        }])),
    };
}

// ---------------------------------------------------------------- cards

/**
 * SillyTavern's chat file naming, so a generated card carries a usable chat name.
 * @returns {string} e.g. `2026-10-12@20h45m25s798ms`.
 */
function humanizedDateTime(date = new Date()) {
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + `@${pad(date.getHours())}h${pad(date.getMinutes())}m${pad(date.getSeconds())}s`
        + `${pad(date.getMilliseconds(), 3)}ms`;
}

/** @returns {object} A Character Card V2 object. */
function card({ name, description, personality = '', scenario = '', firstMes = '', notes, tags, world }) {
    const data = {
        name,
        description,
        personality,
        scenario,
        first_mes: firstMes,
        mes_example: '',
        creator_notes: notes,
        system_prompt: '',
        post_history_instructions: '',
        tags,
        creator: 'Character Hierarchy demo set',
        character_version: '1.0',
        alternate_greetings: [],
        extensions: {
            talkativeness: '0.5',
            fav: false,
            world,
            depth_prompt: { prompt: '', depth: 4, role: 'system' },
        },
        group_only_greetings: [],
    };

    return {
        name,
        description,
        personality,
        scenario,
        first_mes: firstMes,
        mes_example: '',
        creatorcomment: notes,
        avatar: 'none',
        // Not left empty: SillyTavern repairs a *missing* chat name with ??, which does not
        // fire on an empty string, so the card would ask the server for a chat called "".
        chat: `${name} - ${humanizedDateTime()}`,
        talkativeness: '0.5',
        fav: false,
        tags,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data,
        create_date: new Date().toISOString(),
    };
}

// ---------------------------------------------------------------- the demo set

const WORLDS = {
    'Earth': lorebook([
        {
            key: ['gravity', 'falling', 'weight', 'heavy'],
            comment: 'gravity',
            content: 'Surface gravity on Earth is 9.81 m/s². Dropped things accelerate downward and land; nobody native to the planet finds this remarkable.',
        },
        {
            key: ['ocean', 'oceans', 'sea', 'tide', 'tides'],
            comment: 'oceans and tides',
            content: 'Salt water covers about 71% of Earth\'s surface. The tides rise and fall roughly twice a day, pulled by the Moon.',
        },
        {
            key: ['moon', 'night sky', 'stars'],
            comment: 'the Moon',
            content: 'Earth has one moon, about a quarter of the planet\'s diameter. It lights the night, drives the tides, and always shows the same face.',
        },
        {
            key: ['year', 'season', 'seasons', 'winter', 'summer'],
            comment: 'the year',
            content: 'A year is one orbit of the Sun, 365 days and a little more. The planet\'s tilt gives the temperate latitudes four seasons, reversed between the hemispheres.',
        },
        {
            key: ['air', 'breathe', 'atmosphere', 'sky'],
            comment: 'atmosphere',
            content: 'The air is roughly 78% nitrogen and 21% oxygen, thinning with altitude. It scatters blue light, which is why the sky is blue.',
        },
    ]),

    'North America': lorebook([
        {
            key: ['continent', 'north america', 'north american'],
            comment: 'the continent',
            content: 'North America runs from the Arctic islands down to the Isthmus of Panama: Canada, the United States, Mexico, Central America and the Caribbean.',
        },
        {
            key: ['maple', 'autumn', 'fall colors', 'fall colours'],
            comment: 'autumn',
            content: 'Sugar maples turn scarlet across the northeast every October, and the sap they run in late winter is boiled down into syrup.',
        },
        {
            key: ['prairie', 'plains', 'great plains', 'grassland'],
            comment: 'the Great Plains',
            content: 'The Great Plains are a vast grassland in the continent\'s interior, flat enough to see weather arriving an hour before it does. Bison once crossed them in millions.',
        },
        {
            key: ['rockies', 'rocky mountains', 'mountains', 'divide'],
            comment: 'the Rockies',
            content: 'The Rocky Mountains run the length of the continent\'s west. The Continental Divide along their spine decides whether rain ends up in the Pacific or the Atlantic.',
        },
        {
            key: ['hurricane', 'storm season'],
            comment: 'hurricanes',
            content: 'Hurricanes form over the warm Atlantic between June and November and come ashore on the Gulf and east coasts.',
        },
    ]),

    'USA': lorebook([
        {
            key: ['dollar', 'dollars', 'money', 'price', 'cost', 'cents'],
            comment: 'currency',
            content: 'The currency is the US dollar, divided into 100 cents. Prices are quoted before tax, and tipping is expected in restaurants.',
        },
        {
            key: ['congress', 'senate', 'house of representatives', 'law', 'federal'],
            comment: 'government',
            content: 'A federal republic of fifty states. Congress has two chambers: the Senate, two seats per state, and the House, apportioned by population.',
        },
        {
            key: ['baseball', 'world series', 'ballgame'],
            comment: 'baseball',
            content: 'Baseball runs from spring to October, ending in the World Series. Nine innings, three strikes, and an unhurried sense of time.',
        },
        {
            key: ['thanksgiving', 'fourth of july', 'july 4th', 'holiday'],
            comment: 'holidays',
            content: 'Thanksgiving falls on the fourth Thursday of November and involves a great deal of turkey. Independence Day, the fourth of July, means fireworks.',
        },
        {
            key: ['miles', 'fahrenheit', 'gallons', 'units'],
            comment: 'units',
            content: 'Distances are in miles, temperatures in Fahrenheit, fuel in gallons. Freezing is 32°F, a comfortable day is about 70°F.',
        },
        {
            key: ['highway', 'interstate', 'road trip', 'driving'],
            comment: 'the interstates',
            content: 'The Interstate Highway System ties the country together. Even-numbered routes run east to west, odd-numbered ones north to south.',
        },
    ]),

    'Peter': lorebook([
        {
            key: ['peter', 'boat', 'charter', 'fishing', 'fish'],
            comment: 'Peter\'s boat',
            content: 'Peter runs a small charter boat, the *Kestrel*, out of a working harbour. He is out before dawn most days and reads the weather better than any forecast.',
        },
        {
            key: ['nets', 'tackle', 'bait'],
            comment: 'Peter\'s trade',
            content: 'Peter mends his own nets on the dock in the evenings. He is particular about his tackle and lends it to nobody, including Paul.',
        },
    ]),

    'Paul': lorebook([
        {
            key: ['paul', 'guitar', 'song', 'music', 'play'],
            comment: 'Paul\'s music',
            content: 'Paul plays a battered six-string he has owned since he was seventeen. He knows several hundred songs and will perform any of them with very little encouragement.',
        },
        {
            key: ['bar', 'gig', 'tips', 'crowd'],
            comment: 'Paul\'s gigs',
            content: 'Paul plays weekends at whichever bar will have him, for a cut of the door and as much coffee as he can drink.',
        },
    ]),

    'Mary': lorebook([
        {
            key: ['mary', 'garden', 'seeds', 'tomatoes', 'growing'],
            comment: 'Mary\'s garden',
            content: 'Mary keeps a garden that feeds three households. She saves seed every year, labels everything, and has strong views about when to plant out.',
        },
        {
            key: ['preserves', 'jam', 'canning', 'pantry'],
            comment: 'Mary\'s pantry',
            content: 'Mary\'s pantry shelves are full of labelled jars. Nothing from her garden is allowed to go to waste.',
        },
    ]),
};

const CARDS = [
    {
        file: 'Earth',
        colour: [38, 84, 124],
        card: card({
            name: 'Earth',
            description: 'The third planet from the Sun: one moon, breathable air, liquid water across most of its surface, and a single biosphere shared by everything alive. Day is twenty-four hours, a year is a little over three hundred and sixty-five of them. Everything that happens here happens under the same sky.',
            notes: 'Informational card. Root of the demo hierarchy — nest continents under this.',
            tags: ['hierarchy', 'informational', 'world'],
            world: 'Earth',
        }),
    },
    {
        file: 'North America',
        colour: [52, 104, 72],
        card: card({
            name: 'North America',
            description: 'A continent reaching from the Arctic to the tropics, bounded by the Pacific, the Atlantic and the Gulf. Mountains down the western edge, grassland through the middle, old worn hills in the east. Canada, the United States, Mexico, Central America and the Caribbean islands.',
            notes: 'Informational card. Nest under Earth; nest countries under this.',
            tags: ['hierarchy', 'informational', 'world'],
            world: 'North America',
        }),
    },
    {
        file: 'USA',
        colour: [116, 62, 68],
        card: card({
            name: 'USA',
            description: 'A federal republic of fifty states occupying the middle latitudes of North America. Dollars, miles and Fahrenheit. Enormous distances, a highway system built to cross them, and a strong preference for doing so by car.',
            notes: 'Informational card. Nest under North America; nest people under this.',
            tags: ['hierarchy', 'informational', 'world'],
            world: 'USA',
        }),
    },
    {
        file: 'Peter',
        colour: [60, 96, 112],
        card: card({
            name: 'Peter',
            description: '{{char}} is a charter boat skipper in his fifties, weather-beaten and unhurried. He has worked the same stretch of coast his whole life and knows every rock in it. Practical, dry, slow to volunteer an opinion and immovable once he has given one.',
            personality: 'Laconic, practical, patient, quietly stubborn.',
            scenario: 'Peter is on the dock, coiling rope, with an hour to spare before the tide.',
            firstMes: '*Peter glances up from the rope in his hands, squints at the sky, and goes back to coiling.*\n\n"Morning. Tide turns in about an hour, so if you were after going out, now\'s the time to say so."',
            notes: 'Actor card. Nest under USA to inherit the USA, North America and Earth books.',
            tags: ['hierarchy', 'actor'],
            world: 'Peter',
        }),
    },
    {
        file: 'Paul',
        colour: [108, 84, 132],
        card: card({
            name: 'Paul',
            description: '{{char}} is a working musician in his thirties who plays bars, weddings and anywhere else with a power socket. Cheerful, talkative, permanently slightly broke. He will turn any conversation towards music given half a chance.',
            personality: 'Warm, talkative, optimistic, easily distracted.',
            scenario: 'Paul is setting up in the corner of a half-empty bar, tuning by ear.',
            firstMes: '*Paul looks up mid-tune, grins, and keeps turning the peg.*\n\n"Hey! Grab a seat, I\'m nearly done fighting with this thing. Second string\'s been going flat all week."',
            notes: 'Actor card. Nest under USA to inherit the USA, North America and Earth books.',
            tags: ['hierarchy', 'actor'],
            world: 'Paul',
        }),
    },
    {
        file: 'Mary',
        colour: [132, 104, 52],
        card: card({
            name: 'Mary',
            description: '{{char}} is a gardener in her sixties who grows more food than she can eat and gives most of it away. Direct, observant, unsentimental about plants and animals alike. She notices everything and comments on about a third of it.',
            personality: 'Direct, observant, generous, wry.',
            scenario: 'Mary is at the edge of her vegetable beds with a trug over one arm.',
            firstMes: '*Mary straightens up, shifts the trug to her other arm, and looks you over.*\n\n"You\'re just in time to be useful. There\'s more beans on that row than I can carry and they won\'t wait."',
            notes: 'Actor card. Nest under USA to inherit the USA, North America and Earth books.',
            tags: ['hierarchy', 'actor'],
            world: 'Mary',
        }),
    },
];

/** The tree, in the shape the extension's Import button expects. */
const HIERARCHY = {
    format: 'sillytavern-character-hierarchy',
    version: 1,
    exportedAt: new Date().toISOString(),
    // Node keys are typed: `char:` for a character card, `book:` for a lorebook, `persona:`
    // for a persona. Older exports used bare avatar names and are migrated on import.
    nodes: {
        'char:Earth.png': { parent: null, role: 'info', books: [], includeCardText: true },
        'char:North America.png': { parent: 'char:Earth.png', role: 'info', books: [], includeCardText: true },
        'char:USA.png': { parent: 'char:North America.png', role: 'info', books: [], includeCardText: true },
        'char:Peter.png': { parent: 'char:USA.png', role: 'actor', books: [], includeCardText: false },
        'char:Paul.png': { parent: 'char:USA.png', role: 'actor', books: [], includeCardText: false },
        'char:Mary.png': { parent: 'char:USA.png', role: 'actor', books: [], includeCardText: false },
    },
};

// ---------------------------------------------------------------- write it out

for (const dir of ['worlds', 'characters']) {
    rmSync(path.join(HERE, dir), { recursive: true, force: true });
    mkdirSync(path.join(HERE, dir), { recursive: true });
}

for (const [name, book] of Object.entries(WORLDS)) {
    writeFileSync(path.join(HERE, 'worlds', `${name}.json`), JSON.stringify(book, null, 4));
    console.log(`worlds/${name}.json — ${Object.keys(book.entries).length} entries`);
}

for (const { file, colour, card: data } of CARDS) {
    writeFileSync(path.join(HERE, 'characters', `${file}.json`), JSON.stringify(data, null, 4));
    writeFileSync(path.join(HERE, 'characters', `${file}.png`), cardPng(256, colour, data));
    console.log(`characters/${file}.json + .png — lorebook "${data.data.extensions.world}"`);
}

writeFileSync(path.join(HERE, 'hierarchy.json'), JSON.stringify(HIERARCHY, null, 4));
console.log('hierarchy.json — 6 nodes');
