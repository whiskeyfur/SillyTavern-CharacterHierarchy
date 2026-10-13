# Demo set

An importable six-card hierarchy for trying the extension out:

```
Earth              informational   Earth.json          gravity, oceans, the Moon, the year, air
└── North America  informational   North America.json  the continent, autumn, the Plains, the Rockies, hurricanes
    └── USA        informational   USA.json            dollars, Congress, baseball, holidays, units, interstates
        ├── Peter  actor           Peter.json          his charter boat, his tackle
        ├── Paul   actor           Paul.json           his guitar, his gigs
        └── Mary   actor           Mary.json           her garden, her pantry
```

Every card carries its own lorebook and nothing else. Peter, Paul and Mary each know only
their own two entries — everything about the dollar, the prairie or gravity reaches them
purely by inheritance. Ask Peter what something costs and the USA book answers; ask him why
the tide is out and Earth's does.

## Contents

| | |
| --- | --- |
| `characters/*.png` | The six cards, data embedded the way SillyTavern writes it. Import these, or drop them straight into `data/<user>/characters/`. |
| `characters/*.json` | The same six cards as plain V2 JSON, if you would rather import text. |
| `worlds/*.json` | The six lorebooks. Import them, or drop them into `data/<user>/worlds/`. |
| `hierarchy.json` | The tree itself, for the extension's **Import** button. |
| `build.mjs` | Regenerates everything above. `node build.mjs`. |

## Importing

1. **Lorebooks first.** World Info panel → *Import World Info* → select all six files in
   `worlds/`. Do these before the cards, so each card's lorebook link resolves on arrival.
2. **Then the cards.** Characters panel → *Import Character* → select all six PNGs in
   `characters/`.
3. **Then the tree.** Open the hierarchy panel from the sitemap icon in the top bar, then use
   its *import* button → `hierarchy.json`.

Step 3 keys nodes as `char:<avatar file name>`, so it expects `char:Earth.png`,
`char:North America.png`, `char:USA.png`, `char:Peter.png`, `char:Paul.png` and
`char:Mary.png`. If SillyTavern renamed a card on import because one of those names was already
taken, the chart will show the old name greyed out as `(not installed)` — drag the real card in
from the character list and right-click the stale one to remove it.

## Checking it worked

Open the hierarchy panel from the top bar. The chart should show Earth at the top, North America
below it, USA below that, and Peter, Paul and Mary side by side on the bottom row, with the
tray on the right holding whatever other cards you have. Click Peter, then press the
magnifying glass. You should see:

```
Speaker: Peter  [actor]

Ancestors, nearest first:
  1. USA  [info]
  2. North America  [info]
  3. Earth  [info]

Lorebooks pulled in:
  USA — level 1, via USA (6 entries)
  North America — level 2, via North America (5 entries)
  Earth — level 3, via Earth (5 entries)

Card text injected:
  USA — level 1, 217 characters
  North America — level 2, 272 characters
  Earth — level 3, 293 characters

Total entries added this turn: 19
```

`tests/fixtures.mjs` asserts exactly this, so the demo set and this file stay in step.
