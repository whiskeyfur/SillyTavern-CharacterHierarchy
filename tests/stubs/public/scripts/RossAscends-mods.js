/** Minimal stand-in for SillyTavern's RossAscends-mods.js. */
export function dragElement($element) {
    globalThis.__dragged = $element?.[0]?.id ?? null;
}
