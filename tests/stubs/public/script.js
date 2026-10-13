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
