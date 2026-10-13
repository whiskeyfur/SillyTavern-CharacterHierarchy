/** Minimal stand-in for SillyTavern's personas.js. */
export async function getUserAvatars(doRender = true, openPageAt = '') {
    globalThis.__personaNavigatedTo = openPageAt;
    return [];
}
