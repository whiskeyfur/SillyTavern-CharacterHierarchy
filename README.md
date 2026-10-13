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

## What you get

- A drag-and-drop **org chart** in its own top bar panel, with card avatars, connector lines
  and a tray for cards that are not in a tree yet.
- **Inheritance up the whole chain**, not just one level: a grandchild picks up its parent's
  books and its grandparent's.
- **Actor / informational roles**, so lore containers never have to pretend to be characters.
- **Card text injection**, turning an informational card's own description into a world info
  entry for everything below it.
- **Group chat support**: the speaker's ancestry is resolved per message, and informational
  group members can contribute to every message without ever being drafted to speak.
- A **preview** that explains, without running a generation, exactly which books were chosen,
  how far away they were, which card offered them, and what was skipped.
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

Click the **sitemap icon** in the top bar. The panel shows an org chart of your trees, with a
tray down the right holding every card that is not in a tree yet.

- **Drag a card onto another card** to nest it underneath.
- **Drag it onto empty chart space** to make it the root of its own tree.
- **Drag it back to the tray** to take it out of the hierarchy. Its children are lifted up to
  its old parent rather than lost.
- **Click a card** to open its settings under the chart: role, parent, the extra lorebooks it
  holds, and whether its own text is injected. Everything there applies immediately.

A drop that would nest a card inside its own descendants is refused — the target outlines in
red instead of green, and nothing moves. Cards show their avatar, name, role and how many extra
lorebooks they hold; informational cards have a dashed border.

The **sitemap button** in a character's own panel, next to the globe, opens the hierarchy panel
with that card already selected. It lights up when the card is part of a tree, and its tooltip
shows the full path to the root.

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

## Settings

All of these live in the two collapsible sections at the bottom of the panel.

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

The **export** and **import** buttons move a tree between installs as JSON. Cards are tracked
by avatar file name, so an imported tree lines up as long as the same cards are installed. A
card that is missing is shown as `name.png (not installed)` rather than dropped, so a tree
survives a card being renamed and restored.

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
and connector paths are asserted; and `WORLDINFO_ENTRIES_LOADED` is fired to confirm exactly
which entries come back.

`npm run test:fixtures` runs the demo set through the same machinery, so the numbers quoted in
`fixtures/README.md` cannot drift away from what the extension actually does.

## Requirements

A SillyTavern build that emits `WORLDINFO_ENTRIES_LOADED` from `getSortedEntries()`, and whose
top bar is `#top-settings-holder`. Developed and tested against SillyTavern `1.19.0` (commit `06bde93`). If the event is
missing the extension says so in the console and on screen at startup and stays inactive rather
than failing quietly.
