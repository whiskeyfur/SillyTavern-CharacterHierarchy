export const extension_settings = {};

export function getContext() {
    return globalThis.__ctx;
}

/** Reads the extension's real template files, so markup and code stay in step. */
export async function renderExtensionTemplateAsync(_extensionName, templateId) {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    return readFileSync(join(globalThis.__templateDir, `${templateId}.html`), 'utf-8');
}
