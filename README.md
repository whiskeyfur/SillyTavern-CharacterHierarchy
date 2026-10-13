# Character Hierarchy

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that nests character
cards under one another so lore flows down the tree. When a character speaks, their own
lorebooks are scanned as usual — and so are the lorebooks of every card above them, all the
way to the root.

Cards are flagged as **actors**, which take part in the roleplay, or **informational**, which
exist only to hold lore. An informational card is how you represent a house, a city, a guild or
a kingdom: it never speaks, it just sits in the tree and lends what it knows to everyone
beneath it.

```
Kingdom of Aldia          informational   → Aldian Geography, Aldian History
└── House Vance           informational   → Vance Family Secrets
    ├── Sir Brant         actor           → Brant's Private Lore
    └── Mira              actor
```

When Sir Brant speaks, the world info scan sees *Brant's Private Lore*, *Vance Family Secrets*,
*Aldian Geography* and *Aldian History*. When Mira speaks she gets the same inheritance, minus
Brant's own book. Neither card needs the other's lorebooks attached by hand, and adding a fact
to *Aldian History* reaches every character in the kingdom at once.

![The Character Hierarchy panel open in SillyTavern: an org chart with Earth at the root,
North America and USA nested beneath it, and Mary, Paul and Peter side by side on the bottom
row, each card showing its avatar and role.](media/panel.png)

## What you get

- A drag-and-drop **org chart** in its own top bar panel, fed straight from SillyTavern's own
  character list: drag a character out of the list and onto the chart.
- **Lorebooks and personas on the chart too**, not just character cards, so a book can sit in
  the tree without a stand-in card.
- A **focus mode** that narrows a crowded chart to one character's line.
- **Inheritance up the whole chain**, not just one level: a grandchild picks up its parent's
  books and its grandparent's.
- **Actor / informational roles**, so lore containers never have to pretend to be characters.
- **Card text injection**, turning an informational card's own description into a world info
  entry for everything below it.
- **Group chat support**: the speaker's ancestry is resolved per message, and informational
  group members can contribute to every message without ever being drafted to speak.
- A **preview** that explains, without running a generation, exactly which books were chosen,
  how far away they were, which card offered them, and what was skipped.
- A **tri-state filter** in the character list, alongside the favourites and groups toggles,
  for showing only the cards in a hierarchy or hiding them.
- **Slash commands** for scripting, and **JSON export/import** for moving a tree between
  installs.

Nothing is patched into SillyTavern's own files, and no character card is ever rewritten.

## Installing

In SillyTavern, open **Extensions → Install extension** and paste:

```
https://github.com/whiskeyfur/SillyTavern-CharacterHierarchy
```

Or clone it yourself:

```bash
git clone https://github.com/whiskeyfur/SillyTavern-CharacterHierarchy \
  SillyTavern/public/scripts/extensions/third-party/SillyTavern-CharacterHierarchy
```

Then reload SillyTavern. A **sitemap icon** appears in the top bar next to World Info, and
everything — the chart, the per-card settings and the inheritance options — lives in that
panel. The Extensions tab carries a pointer to it rather than a second copy of the controls.

If *Movable UI panels* is on in User Settings, the panel can be dragged by its grip and resized
from its corner, like World Info and the other panels.

## Building a tree

Click the **sitemap icon** in the top bar. SillyTavern's character list comes up alongside the
chart, since that is where new cards are dragged from, and goes back to however you had it when
you close the chart again. (Not on a phone, where two panels side by side do not fit.)

- **Drag a character out of the character list** and onto the chart to add it. Rows already on
  the chart are dimmed while the panel is open, so you can see at a glance what is left; close
  the panel and the list goes back to normal.
- **Drag a node onto another node** to nest it underneath.
- **Drag it onto empty chart space** to make it the root of its own tree.
- **Click a node** to open its settings under the chart, and a small strip of actions directly
  beneath the node itself. Everything applies immediately. Clicking empty chart space clears
  the selection again.
- **Double-click a node** to open the thing it stands for: a character's chat, a persona in the
  persona manager, or a lorebook in the world info editor.

A drop that would nest a node inside its own descendants is refused — the target outlines in
red instead of green, and nothing moves. Nodes show their portrait, name, role and how many
extra lorebooks they hold; informational cards have a dashed border.

### Focusing on one line

Once you have more than one tree, the chart gets busy. The **crosshairs** button in the panel
header narrows it to a single line: the selected node, everything above it, and everything
below it. Other roots and the side branches off shared ancestors drop out of view, and a note
along the bottom says how many nodes are hidden so a half-empty chart is never a mystery.

Clicking a different node re-focuses on that one. With nothing selected it follows whichever
character is currently open, so opening the panel mid-chat shows that character's line. The
toggle is remembered between sessions, and nothing is deleted — it only changes what is drawn.

### Taking something off the chart

Three ways, whichever is nearest to hand:

- **Right-click** the node and choose *Take off the chart*. The same menu offers *Edit*,
  *Detach from parent* and *Focus on this line*.
- **Click it**, then use the bin in the strip that appears under it, or in the settings panel.
- **Drag it off the chart** and let go. The ghost turns red to say what will happen.

Removing a node never touches the card, lorebook or persona itself — it only stops the
inheritance. Its children are lifted up to its old parent rather than lost.

### Lorebooks and personas

The two buttons in the panel header put a **lorebook** or a **persona** on the chart beside your
character cards. A lorebook node simply *is* its book: everything nested under it inherits that
book, with no stand-in character card needed. A persona hands down whichever lorebook is
assigned to it, and can inject its own description just like an informational card.

Neither ever speaks, so neither has a role to choose, and both are drawn with an icon where a
card would show its portrait.

The **sitemap button** in a character's own panel, next to the globe, opens the hierarchy panel
with that card already selected. It lights up when the card is part of a tree, and its tooltip
shows the full path to the root.

### Filtering the character list

A sitemap button joins the favourites, groups and folders toggles above the character list, and
cycles the same three ways they do:

| Click | State | Effect |
| --- | --- | --- |
| — | off | Every card is listed, as usual. |
| once | only | Lists just the cards that are in a hierarchy. |
| twice | exclude | Hides them, leaving everything that is not nested. |

*Exclude* is the one to reach for when informational cards — kingdoms, houses, factions — are
cluttering a list you are trying to pick a character from. Folders are left visible in both
states, and the choice is remembered between sessions.

### Roles

| Role | Meaning |
| --- | --- |
| **Actor** | Takes part in the roleplay. Inherits lore from its ancestors. |
| **Informational** | A lore container. Lends lore to its descendants, and — in a group chat — to the whole chat. |

Nothing stops an informational card from being used as a speaker; the flag is about what the
extension does with it, not a lock. The useful trick runs the other way: add an informational
card to a group chat and **disable** it in the member list. It will never be picked to speak,
but its lore still applies to every message in that chat.

### What a card hands down

Everything nested under a card inherits that card's lorebooks — its own "Character Lore" book,
anything linked through "Link to World Info", and any extra books attached to it here. That
applies at every level, so inheritance accumulates all the way to the root.

The card settings panel states this in both directions: *"Everything nested under this card
inherits: …"* for what it hands down, and an **Inherited from above** list naming each book,
which level it came from and which card offered it. If a book you expect is missing from that
list, the four switches under *What gets inherited* are what to check.

### Extra lorebooks

Each card in the tree can hold extra lorebooks that this extension tracks itself, separate from
SillyTavern's own "Character Lore" and "Link to World Info" fields. This matters for
informational cards, which you may never want to open as characters at all.

### Card text

An informational card's own description is often the lore itself. Switch on *Inject this card's
own text as a world info entry* in its settings and the extension builds an entry for every
descendant from a template:

```
[{{name}}]
{{description}}
```

Placeholders: `{{name}}`, `{{description}}`, `{{personality}}`, `{{scenario}}`,
`{{mesExamples}}`, `{{creatorNotes}}`. They read the **ancestor's** card, not the speaker's.

The *Informational card text* section of the panel controls how the resulting entry behaves:

| Setting | Default | What it does |
| --- | --- | --- |
| Always active | on | The entry is constant. Switch it off and it is keyed on the ancestor's name instead, so it only fires when that name comes up. |
| Position | before character defs | Where the entry lands, matching world info's own positions: before or after the character definitions, top or bottom of the Author's Note, or at a depth. |
| Depth | 4 | How far back in the chat the entry sits, when positioned at depth. |
| Insertion order | 100 | Ordering against other entries, exactly as an ordinary world info entry's order works. |

## Settings

These live in the *What gets inherited* section at the bottom of the panel. The card text
settings are in the section below it, and are covered under [Card text](#card-text).

| Setting | Default | What it does |
| --- | --- | --- |
| Ancestor primary lorebook | on | Inherit each ancestor's own "Character Lore" book. |
| Ancestor auxiliary lorebooks | on | Inherit books linked to an ancestor via "Link to World Info". |
| Ancestor extra books | on | Inherit books attached to an ancestor in this extension. |
| Speaker's own extra books | on | Also apply the speaker's own books attached in this extension. |
| Whose ancestors to scan in group chats | speaker | *Only the character currently speaking* matches how SillyTavern already handles character lore. *Every member of the group* pulls in every member's books and ancestry on every message — heavier, but keeps the whole cast present. |
| Always include informational group members | on | Informational cards in a group contribute regardless of who is speaking, and regardless of whether they are enabled as speakers. |
| Maximum levels to walk up | 16 | A safety rail for deep trees. |
| Order penalty per level | 0 | At 0, every inherited entry keeps the insertion order its author gave it. Raise it and each level of distance subtracts that much, so a close ancestor outranks a distant one when the world info budget runs out. This changes entry hashes, which resets sticky and cooldown timers once. |
| Inject card text | on | Honour the per-card *inject card text* switch. |
| Log inheritance decisions | off | Prints the books chosen, their distance, which card offered them, and what was skipped, on every scan. |

The **magnifying glass** in the panel header shows all of that for the selected card without
running a generation: the ancestor chain, the books pulled in and where each came from, the
card text injected, and what was skipped because something else already scans it.

The **export** and **import** buttons move a tree between installs as JSON. Nodes are keyed by
type and id — `char:Seraphina.png`, `book:Eldoria`, `persona:user.png` — so an imported tree
lines up as long as the same things are installed. Anything missing is shown as
`(not installed)` rather than dropped, so a tree survives something being renamed and restored.
Exports made before lorebooks and personas could sit on the chart used bare avatar names, and
are migrated on import.

## Slash commands

| Command | What it does |
| --- | --- |
| `/hierarchy-chain char=Brant` | Lists a card's ancestors, nearest first. |
| `/hierarchy-role char=Brant info` | Gets or sets a role (`actor` or `info`). |
| `/hierarchy-parent char=Brant House Vance` | Gets or sets the parent. An empty value detaches. |
| `/hierarchy-books char=Brant` | Lists the lorebooks that card inherits right now. |

`char` defaults to the selected character and accepts a name or an avatar file name.

## Trying it out

`fixtures/` holds an importable demo set: `Earth` → `North America` → `USA` → `Peter`, `Paul`
and `Mary`, six cards with six lorebooks between them. Each person knows only their own two
entries; everything about the dollar, the prairie or gravity reaches them by inheritance. See
[fixtures/README.md](fixtures/README.md) for the import order.

## How it works

SillyTavern assembles world info in `getSortedEntries()`, which gathers global, character, chat
and persona lore and then emits `WORLDINFO_ENTRIES_LOADED` with those arrays before consuming
them. This extension listens for that event and appends to `characterLore`.

On each scan it:

1. Reads the speaking character from the context. In a group chat SillyTavern has already
   pointed `characterId` at the drafted member, so the speaker is whoever is about to talk.
2. Walks up the tree from that card, collecting each ancestor's books.
3. Drops books something else is already scanning — the global selection, the chat lorebook,
   the persona lorebook, and the speaker's own card books. Nothing is loaded twice.
4. Collapses books reached through more than one ancestor down to the nearest one.
5. Loads each book and appends its entries, tagged with the book they came from.

Inherited entries are otherwise left alone, so keys, probabilities, inclusion groups, character
filters, recursion flags and timed effects behave exactly as they would if you had attached the
book to the card by hand. In particular nothing is added to the entry objects, which keeps the
hashes SillyTavern uses for sticky and cooldown timers stable from turn to turn.

Cards SillyTavern has only stubbed are loaded in full before their lorebook field is read, and
the cards a chat can reach are warmed up when the chat changes, so the scan itself never waits
on the network.

The tree is stored in SillyTavern's extension settings rather than written into the character
cards. That keeps stub cards usable and means the extension never rewrites your card files; the
cost is that a card carries no memory of its place in the tree when you share it, which is what
export and import are for.

## Tests

```bash
cd tests
npm install
npm test
```

The suite lays out a throwaway copy of SillyTavern's module layout with stubs in place of the
real modules, loads the extension into jsdom, and drives it end to end. The panel is rendered
from the real `drawer.html`, so the markup and the code that binds to it cannot drift apart;
the top bar drawer is opened and closed through its own toggle; cards are dragged around the
chart with synthesised pointer events and the resulting tree is checked; the chart's geometry
and connector paths are asserted; the character list filter is cycled through its three states
and the resulting list inspected; and `WORLDINFO_ENTRIES_LOADED` is fired to confirm exactly
which entries come back.

`npm run test:fixtures` runs the demo set through the same machinery, so the numbers quoted in
`fixtures/README.md` cannot drift away from what the extension actually does.

## Requirements

Developed and tested against SillyTavern `1.19.0` (commit `06bde93`).

Extensions have no formal API for most of this, so the extension imports a handful of
SillyTavern's own modules. Each piece fails on its own rather than taking the rest down, and
says why in the console:

| What it uses | For | If it is missing |
| --- | --- | --- |
| `WORLDINFO_ENTRIES_LOADED` from `getSortedEntries()` | The whole point: appending inherited entries | Says so in the console and on screen at startup, and stays inactive |
| `#top-settings-holder` | Adding the panel to the top bar | Logs an error; inheritance still runs, but there is no interface to edit the tree with |
| `doNavbarIconClick` from `script.js` | Opening and closing the panel like every other drawer | Build error at load |
| `entitiesFilter` and `filters.js` | The character list filter | Build error at load |
| `#rm_characters_block .rm_tag_filter` | Placing the filter button | Logs a warning; everything else still works |
| `#rm_print_characters_block` and `.character_select[data-chid]` | Dragging characters onto the chart, and dimming the ones already there | Logs a warning; lorebooks and personas can still be added from the panel header |
| `power_user.personas` and `persona_descriptions` | Putting personas on the chart | Personas simply do not appear as candidates |
| `openWorldInfoEditor` and `getUserAvatars` | Double-clicking a lorebook or persona to open it | Build error at load |
| `dragElement` from `RossAscends-mods.js` | Dragging and resizing the panel, and only when *Movable UI panels* is on | Logs a warning; the panel still works, just fixed in place |

The world info side — the part that actually matters — depends only on the event and on
`world-info.js`. The rest is user interface.

## License

[GNU Affero General Public License v3.0 or later](LICENSE), the same license SillyTavern itself
uses. If you run a modified version of this extension on a server other people interact with
over a network, the AGPL requires you to offer them the modified source.
