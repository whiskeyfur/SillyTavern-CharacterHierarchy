export const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 };
export const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
export class Popup {
    constructor(content) { this.content = content; globalThis.__lastPopup = content; }
    async show() {
        // Lets a test fill in the popup's controls before it "accepts".
        globalThis.__onPopup?.(this.content);
        return POPUP_RESULT.AFFIRMATIVE;
    }
}
