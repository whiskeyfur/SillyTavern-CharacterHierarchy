export function getCharaFilename(chid = null, { manualAvatarKey = null } = {}) {
    const ctx = globalThis.__ctx;
    const fileName = manualAvatarKey ?? ctx.characters[chid ?? ctx.characterId]?.avatar;
    return fileName?.replace(/\.[^/.]+$/, '') ?? null;
}
export function download(content, name) { globalThis.__downloaded = { content, name }; }
export async function getFileText(file) { return file.text(); }
