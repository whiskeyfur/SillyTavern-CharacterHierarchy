/** Minimal stand-in for SillyTavern's script.js. */
export async function doNavbarIconClick() {
    // Mirrors the real handler closely enough for the drawer to behave: swap the open/closed
    // classes on this toggle's drawer, after closing whatever else was open.
    const toggle = this[0] ?? this;
    const drawer = toggle.parentElement;
    const content = drawer?.querySelector('.drawer-content');
    const icon = toggle.querySelector('.drawer-icon');

    if (!content) {
        return;
    }

    if (!content.classList.contains('openDrawer')) {
        for (const open of document.querySelectorAll('.openDrawer:not(.pinnedOpen)')) {
            open.classList.replace('openDrawer', 'closedDrawer');
        }
        for (const open of document.querySelectorAll('.openIcon:not(.drawerPinnedOpen)')) {
            open.classList.replace('openIcon', 'closedIcon');
        }
        content.classList.replace('closedDrawer', 'openDrawer');
        icon?.classList.replace('closedIcon', 'openIcon');
    } else {
        content.classList.replace('openDrawer', 'closedDrawer');
        icon?.classList.replace('openIcon', 'closedIcon');
    }
}

/**
 * Stand-in for SillyTavern's shared character list filter. Mirrors the real FilterHelper
 * closely enough for the extension's tri-state button: public filterData/filterFunctions,
 * a tri-state helper, and an onDataChanged callback that short-circuits on equal values.
 */
export const entitiesFilter = {
    filterData: {},
    filterFunctions: {},
    onDataChanged: () => { globalThis.__listRepaints = (globalThis.__listRepaints ?? 0) + 1; },
    setFilterData(type, data) {
        const old = this.filterData[type];
        this.filterData[type] = data;
        if (JSON.stringify(old) !== JSON.stringify(data)) {
            this.onDataChanged();
        }
    },
    filterDataByState(data, state, predicate, { includeFolders = false } = {}) {
        if (state === 'SELECTED') {
            return data.filter((e) => predicate(e) || (includeFolders && e.type === 'tag'));
        }
        if (state === 'EXCLUDED') {
            return data.filter((e) => !predicate(e) || (includeFolders && e.type === 'tag'));
        }
        return data;
    },
    applyFilters(data) {
        return Object.values(this.filterFunctions).reduce((acc, fn) => fn(acc), data);
    },
};
