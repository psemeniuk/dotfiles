import type { AutocompleteProvider } from "@earendil-works/pi-tui";

/** Keep commands registered, but only advertise actions that currently apply. */
export function commentsAutocomplete(current: AutocompleteProvider, available: () => { drafts: boolean; comments: boolean }): AutocompleteProvider {
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const result = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!result || !/^\/[\w-]*$/.test(lines[cursorLine]?.slice(0, cursorCol) ?? "")) return result;
      const state = available();
      const items = result.items.filter(item => {
        const command = item.value.replace(/^\//, "");
        return !(command === "submit-comments" && !state.drafts) && !(command === "cancel-comments" && !state.comments);
      });
      return items.length ? { ...result, items } : null;
    },
    applyCompletion: (...args) => current.applyCompletion(...args),
    ...(current.shouldTriggerFileCompletion ? { shouldTriggerFileCompletion: (...args: Parameters<NonNullable<AutocompleteProvider["shouldTriggerFileCompletion"]>>) => current.shouldTriggerFileCompletion!(...args) } : {}),
  };
}
