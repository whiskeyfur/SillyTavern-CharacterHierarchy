/** Minimal stand-in for SillyTavern's filters.js. */
export const FILTER_STATES = {
    SELECTED: { key: 'SELECTED', class: 'selected' },
    EXCLUDED: { key: 'EXCLUDED', class: 'excluded' },
    UNDEFINED: { key: 'UNDEFINED', class: 'undefined' },
};
export const DEFAULT_FILTER_STATE = FILTER_STATES.UNDEFINED.key;
