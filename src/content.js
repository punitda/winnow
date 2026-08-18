/**
 * Winnow — hides AI bot comments on GitHub pull requests.
 *
 * The unit of work is one comment by one author. GitHub has no single class for
 * that: most comments are a `.timeline-comment-group`, but some partials (code
 * scanning and code quality alerts) emit a bare `.js-comment` instead, and the
 * two nest — a review wrapper can hold ten comments. So the unit is the
 * *innermost* of either, which is the only node guaranteed to map to one author.
 *
 * Hiding at the `.js-timeline-item` level instead looks tempting (it's a
 * one-line CSS rule) but it's wrong: a bot review thread that a human replied
 * inside is a single timeline item, so that rule silently eats the human
 * replies too.
 */
(() => {
	'use strict';

	const UNIT_SEL = '.timeline-comment-group, .js-comment';
	// Only units carry this attribute, so it doubles as a "this is a unit" marker.
	const BOT_UNIT = '[data-winnow-bot="1"]';
	// Wrappers that may hold several units. When every unit inside is a bot's, we
	// hide the whole wrapper so the avatar rail and thread chrome go with it.
	const CONTAINERS = ['.js-timeline-item', '.js-resolvable-timeline-thread-container'];
	const PR_PATH = /^\/[^/]+\/[^/]+\/pull\/\d+/;

	const HIDDEN = 'winnow-hidden';
	const STUB = 'winnow-stub';

	let enabled = true;
	let denylist = new Set();
	// Threads the user has clicked open. Keyed by container element, so it resets
	// on navigation when GitHub swaps the DOM out.
	let revealed = new WeakSet();
	let stubs = new WeakMap();
	let chip = null;
	let scheduled = false;

	const depthOf = (el) => {
		let d = 0;
		for (let n = el.parentElement; n; n = n.parentElement) d++;
		return d;
	};

	const isPrPage = () => PR_PATH.test(location.pathname);

	/** These wrappers nest, so only the innermost one maps to a single author. */
	const unitsIn = (root) =>
		[...root.querySelectorAll(UNIT_SEL)].filter((el) => !el.querySelector(UNIT_SEL));

	const loginOf = (link) =>
		(link.textContent || '').trim() || (link.getAttribute('href') || '').replace(/^\/(apps\/)?/, '');

	/** GitHub renders app bots as a link to /apps/<name> with no user hovercard,
	 *  which is the most reliable signal available in the DOM. */
	function isBotLink(link) {
		const href = link.getAttribute('href') || '';
		if (href.startsWith('/apps/')) return true;
		const login = loginOf(link);
		// GitHub App accounts carry a [bot] suffix even when rendered as users.
		if (/\[bot\]$/i.test(login)) return true;
		// OAuth-app reviewers post as ordinary accounts and have no marker at all,
		// so the user has to name them. See popup.html.
		return denylist.has(login.toLowerCase());
	}

	/** True when anything inside was written by a person. Used as the veto on
	 *  collapsing a wrapper: it reads the author links directly rather than
	 *  trusting that every comment got segmented into a unit, so an unrecognised
	 *  comment layout can never cause a human to be hidden. */
	const hasHuman = (el) => [...el.querySelectorAll('a.author')].some((a) => !isBotLink(a));

	/** Tag every unit with its author and whether it's a bot. Idempotent — units
	 *  keep their verdict once assigned, so repeat passes are cheap. */
	function classify() {
		for (const unit of unitsIn(document)) {
			if (unit.dataset.winnowBot !== undefined) continue;
			const link = unit.querySelector('a.author');
			// No author yet means the comment is still loading; leave it unmarked
			// so a later pass picks it up.
			if (!link) continue;
			unit.dataset.winnowAuthor = loginOf(link);
			unit.dataset.winnowBot = isBotLink(link) ? '1' : '0';
		}
	}

	function clearVerdicts() {
		for (const unit of document.querySelectorAll('[data-winnow-bot]')) {
			delete unit.dataset.winnowBot;
			delete unit.dataset.winnowAuthor;
		}
	}

	function stubFor(container, botCount, isRevealed) {
		let stub = stubs.get(container);
		if (!stub || !stub.isConnected) {
			stub = document.createElement('div');
			stub.className = STUB;
			const button = document.createElement('button');
			button.type = 'button';
			stub.appendChild(button);
			button.addEventListener('click', () => {
				if (revealed.has(container)) revealed.delete(container);
				else revealed.add(container);
				apply();
			});
			// Sit where the first hidden comment was, so the human reply below it
			// keeps its context.
			const firstBot = container.querySelector(BOT_UNIT);
			if (firstBot && firstBot.parentNode) firstBot.parentNode.insertBefore(stub, firstBot);
			else container.prepend(stub);
			stubs.set(container, stub);
		}
		const label = botCount === 1 ? '1 bot comment' : `${botCount} bot comments`;
		stub.querySelector('button').textContent = isRevealed ? `Hide ${label}` : `Show ${label}`;
		stub.classList.toggle('is-revealed', isRevealed);
	}

	function removeStub(container) {
		const stub = stubs.get(container);
		if (stub) stub.remove();
		stubs.delete(container);
	}

	function apply() {
		if (!isPrPage()) {
			teardown();
			return;
		}
		classify();

		// A comment can change verdict under us — the user edits the denylist, or
		// GitHub reuses a node. Nothing below ever clears the hidden class off a
		// human, so do it here and let the rest of the pass re-hide what it owns.
		for (const unit of document.querySelectorAll(`[data-winnow-bot="0"].${HIDDEN}`)) {
			unit.classList.remove(HIDDEN);
		}

		let hiddenCount = 0;
		let botTotal = 0;
		const claimed = new Set();

		// Containers nest: a thread wrapper sits inside a timeline item. Walk
		// innermost-first and let each container claim the comments it owns, so a
		// comment is decided exactly once and the outer wrapper doesn't re-count
		// it or stack a second stub on top.
		const containers = [...document.querySelectorAll(CONTAINERS.join(','))].sort(
			(a, b) => depthOf(b) - depthOf(a)
		);

		for (const container of containers) {
			const units = unitsIn(container).filter((u) => !claimed.has(u));
			if (!units.length) continue;
			units.forEach((u) => claimed.add(u));

			const bots = units.filter((u) => u.dataset.winnowBot === '1');
			botTotal += bots.length;

			if (!bots.length) {
				removeStub(container);
				continue;
			}

			const isRevealed = revealed.has(container);
			const hide = enabled && !isRevealed;
			if (hide) hiddenCount += bots.length;

			if (bots.length === units.length) {
				// Everything here is a bot's. Hiding the individual comments is
				// enough; the pass below folds up the surrounding chrome.
				bots.forEach((u) => u.classList.toggle(HIDDEN, hide));
				removeStub(container);
			} else {
				// A human said something in this thread. Never collapse it, and
				// always leave a stub so their reply keeps its context.
				bots.forEach((u) => u.classList.toggle(HIDDEN, hide));
				if (enabled) stubFor(container, bots.length, isRevealed);
				else removeStub(container);
			}
		}

		// Comments outside any wrapper we know about — GitHub moves markup around
		// and a layout change shouldn't silently switch the filter off.
		for (const unit of document.querySelectorAll(BOT_UNIT)) {
			if (claimed.has(unit)) continue;
			botTotal += 1;
			unit.classList.toggle(HIDDEN, enabled);
			if (enabled) hiddenCount += 1;
		}

		// Fold up wrappers holding nothing but bot comments, so the avatar rail and
		// thread lines go too instead of leaving an empty frame behind.
		//
		// The veto is hasHuman(), which scans author links rather than units. If
		// GitHub ships another comment layout we don't segment yet, the worst case
		// is a bot comment we fail to hide — never a human comment we swallow.
		for (const container of containers) {
			const foldable = container.querySelector(BOT_UNIT) && !hasHuman(container);
			container.classList.toggle(HIDDEN, !!foldable && enabled && !revealed.has(container));
		}

		renderChip(hiddenCount, botTotal);
	}

	function teardown() {
		for (const el of document.querySelectorAll(`.${HIDDEN}`)) el.classList.remove(HIDDEN);
		for (const el of document.querySelectorAll(`.${STUB}`)) el.remove();
		if (chip) {
			chip.remove();
			chip = null;
		}
	}

	function renderChip(hiddenCount, botTotal) {
		if (!botTotal) {
			if (chip) {
				chip.remove();
				chip = null;
			}
			return;
		}
		if (!chip) {
			chip = document.createElement('div');
			chip.id = 'winnow-chip';
			const button = document.createElement('button');
			button.type = 'button';
			button.addEventListener('click', () => {
				chrome.storage.local.set({ enabled: !enabled });
			});
			chip.appendChild(button);
			document.body.appendChild(chip);
		}
		const button = chip.querySelector('button');
		button.textContent = enabled
			? `${hiddenCount} bot comment${hiddenCount === 1 ? '' : 's'} hidden`
			: `Filter ${botTotal} bot comment${botTotal === 1 ? '' : 's'}`;
		chip.classList.toggle('is-off', !enabled);
	}

	/** Coalesce bursts of mutations into one pass on the next frame. Our own DOM
	 *  writes re-trigger the observer, but apply() is idempotent so it settles
	 *  after one extra pass instead of looping. */
	function schedule() {
		if (scheduled) return;
		scheduled = true;
		const run = () => {
			scheduled = false;
			apply();
		};
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
		else setTimeout(run, 16);
	}

	async function init() {
		const stored = await chrome.storage.local.get(['enabled', 'denylist']);
		enabled = stored.enabled !== false;
		denylist = new Set((stored.denylist || []).map((s) => s.toLowerCase()));

		chrome.storage.onChanged.addListener((changes, area) => {
			if (area !== 'local') return;
			if (changes.enabled) enabled = changes.enabled.newValue !== false;
			if (changes.denylist) {
				denylist = new Set((changes.denylist.newValue || []).map((s) => s.toLowerCase()));
				// Cached verdicts are stale once the denylist moves.
				clearVerdicts();
			}
			apply();
		});

		// GitHub streams the timeline in via include-fragment and re-renders the
		// whole page on Turbo navigation, so almost nothing we care about exists
		// at document_idle. The observer is what makes this work at all.
		new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });

		let lastUrl = location.href;
		const onNavigate = () => {
			if (location.href === lastUrl) return;
			lastUrl = location.href;
			revealed = new WeakSet();
			schedule();
		};
		document.addEventListener('turbo:load', onNavigate);
		document.addEventListener('pjax:end', onNavigate);
		setInterval(onNavigate, 500);

		apply();
	}

	init();
})();
