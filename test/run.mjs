/**
 * Runs the real content script against saved GitHub PR markup.
 *
 * The fixtures are verbatim HTML from ArcReel/ArcReel#1817, a PR with 44
 * comments: 25 from three different review bots, 19 from one human, tangled
 * together in 13 threads where the human replied underneath a bot. That mix is
 * the whole reason this test exists — it's the case a naive selector gets wrong.
 *
 * When GitHub reshuffles their markup this is what tells you. Refresh a fixture:
 *   curl -sL -A "Mozilla/5.0 ... Chrome/140 Safari/537.36" \
 *     https://github.com/OWNER/REPO/pull/N > test/fixtures/pr-conversation.html
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src', 'content.js');

let failures = 0;
const check = (name, ok, got) => {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  -> ${JSON.stringify(got)}`}`);
	if (!ok) failures++;
};

/** Boot the content script over a fixture with a stubbed chrome.storage. */
function load(fixture, url) {
	const dom = new JSDOM(readFileSync(join(here, 'fixtures', fixture), 'utf8'), {
		url,
		runScripts: 'outside-only',
	});
	const { window } = dom;
	const store = { enabled: true, denylist: [] };
	const listeners = [];
	window.chrome = {
		storage: {
			local: {
				get: async (keys) =>
					Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((n) => [n, store[n]])),
				set: async (obj) => {
					const changes = Object.fromEntries(
						Object.entries(obj).map(([k, v]) => [k, { newValue: v }])
					);
					Object.assign(store, obj);
					listeners.forEach((fn) => fn(changes, 'local'));
				},
			},
			onChanged: { addListener: (fn) => listeners.push(fn) },
		},
	};
	vm.runInContext(readFileSync(SRC, 'utf8'), dom.getInternalVMContext());
	return window;
}

const settle = () => new Promise((r) => setTimeout(r, 200));

const shown = (el) => {
	for (let n = el; n; n = n.parentElement) if (n.classList?.contains('winnow-hidden')) return false;
	return true;
};

const UNIT_SEL = '.timeline-comment-group, .js-comment';
const unitsIn = (root) =>
	[...root.querySelectorAll(UNIT_SEL)].filter((el) => !el.querySelector(UNIT_SEL));

/** Ground truth, independent of how the extension segments comments: every
 *  author link on the page, and whether it ended up visible. This is what
 *  actually matters — if a person's name is hidden, a person's comment is gone. */
function authorLinks(window) {
	return [...window.document.querySelectorAll('a.author')].map((a) => ({
		login: (a.textContent || '').trim(),
		bot: (a.getAttribute('href') || '').startsWith('/apps/') ||
			/\[bot\]$/i.test((a.textContent || '').trim()),
		shown: shown(a),
	}));
}

function snapshot(window) {
	const units = unitsIn(window.document);
	const links = authorLinks(window);
	return {
		total: units.length,
		bots: units.filter((u) => u.dataset.winnowBot === '1').length,
		humans: units.filter((u) => u.dataset.winnowBot === '0').length,
		unclassified: units.filter((u) => u.dataset.winnowBot === undefined).length,
		botsShown: units.filter((u) => u.dataset.winnowBot === '1' && shown(u)).length,
		humansShown: units.filter((u) => u.dataset.winnowBot === '0' && shown(u)).length,
		humanLinksHidden: links.filter((l) => !l.bot && !l.shown).map((l) => l.login),
		stubs: window.document.querySelectorAll('.winnow-stub').length,
		chip: window.document.querySelector('#winnow-chip button')?.textContent,
	};
}

console.log('\nconversation tab');
{
	const window = load('pr-conversation.html', 'https://github.com/ArcReel/ArcReel/pull/1817');
	await settle();
	const s = snapshot(window);

	check('every comment gets a verdict', s.unclassified === 0, s);
	check('finds 25 bot and 18 human comments', s.bots === 25 && s.humans === 18, s);
	check('hides no human', s.humansShown === 18 && s.humanLinksHidden.length === 0, s);
	check('leaks no bot', s.botsShown === 0, s);
	check('counts each hidden comment once', s.chip === '25 bot comments hidden', s.chip);
	check('one stub per mixed thread', s.stubs === 13, s.stubs);

	await window.chrome.storage.local.set({ enabled: false });
	await settle();
	const off = snapshot(window);
	check('toggling off restores everything', off.botsShown === 25 && off.humansShown === 18, off);
	check('toggling off removes the stubs', off.stubs === 0, off.stubs);

	await window.chrome.storage.local.set({ enabled: true });
	await settle();
	check('toggling back on re-hides', snapshot(window).botsShown === 0, snapshot(window));

	const stub = window.document.querySelector('.winnow-stub button');
	stub.click();
	await settle();
	const revealed = snapshot(window);
	check('a stub reveals only its own thread', revealed.botsShown > 0 && revealed.botsShown < 25, revealed);
	check('the stub turns into a hide control', /^Hide /.test(stub.textContent), stub.textContent);
	stub.click();
	await settle();
	check('clicking it again re-hides', snapshot(window).botsShown === 0, snapshot(window));

	await window.chrome.storage.local.set({ denylist: ['Pollo3470'] });
	await settle();
	check('denylist catches a bot posting as a user', snapshot(window).humansShown === 0, snapshot(window));
	await window.chrome.storage.local.set({ denylist: [] });
	await settle();
	check("removing from the denylist restores them", snapshot(window).humansShown === 18, snapshot(window));
}

console.log('\nfiles changed tab');
{
	const window = load('pr-files.html', 'https://github.com/ArcReel/ArcReel/pull/1817/files');
	await settle();
	const s = snapshot(window);
	check('classifies inline review comments', s.unclassified === 0 && s.bots === 1 && s.humans === 1, s);
	check('hides no human', s.humansShown === s.humans, s);
	check('leaks no bot', s.botsShown === 0, s);
}

// Regression: github-code-quality renders through a partial that emits a bare
// `.js-comment` with no `.timeline-comment-group` wrapper, so an earlier version
// that keyed only on the latter let all of its comments through.
console.log('\ncode quality alerts (bare .js-comment)');
{
	const window = load(
		'pr-code-quality.html',
		'https://github.com/DashFin-FarDb/financial-asset-relationship-db/pull/181'
	);
	await settle();
	const s = snapshot(window);
	const authors = new Set(
		unitsIn(window.document)
			.filter((u) => u.dataset.winnowBot === '1')
			.map((u) => u.dataset.winnowAuthor)
	);
	check('catches github-code-quality', authors.has('github-code-quality'), [...authors]);
	check('every comment gets a verdict', s.unclassified === 0, s);
	check('hides no human', s.humanLinksHidden.length === 0, s.humanLinksHidden);
	check('leaks no bot', s.botsShown === 0, s);
	check('finds all 32 bots across 10+ vendors', s.bots === 32 && authors.size >= 10, {
		bots: s.bots,
		vendors: authors.size,
	});
}

console.log('\nnon-PR page');
{
	const window = load('pr-conversation.html', 'https://github.com/ArcReel/ArcReel');
	await settle();
	const s = snapshot(window);
	const untouched = [...window.document.querySelectorAll('.timeline-comment-group')].every(shown);
	check('classifies nothing off a PR page', s.unclassified === s.total, s);
	check('hides nothing and shows no chip', untouched && s.stubs === 0 && !s.chip, s);
}

console.log(failures ? `\n${failures} failing\n` : '\nall passing\n');
process.exit(failures ? 1 : 0);
