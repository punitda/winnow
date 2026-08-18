/**
 * Flips the shared `enabled` flag. Content scripts pick the change up through
 * storage.onChanged, so every open PR tab toggles together.
 */
chrome.commands.onCommand.addListener(async (command) => {
	if (command !== 'toggle-filter') return;
	const { enabled } = await chrome.storage.local.get('enabled');
	await chrome.storage.local.set({ enabled: enabled === false });
});
