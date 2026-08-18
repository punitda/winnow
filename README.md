# Winnow

Hides AI review-bot comments on GitHub pull requests so you can read what your
coworkers actually said.

No server, no token, no API calls — it filters the page you're already looking
at. v0 is deliberately a dogfooding tool: use it for a week and find out whether
filtering alone is enough.

## Install

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → pick this folder
3. Open any PR

A pill in the bottom-right corner shows how many comments are hidden. Click it,
or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>, to toggle. The toggle is
shared across every open tab.

## How it decides what's a bot

GitHub renders an App bot's name as a link to `/apps/<name>` with no user
hovercard, while a person gets `/<login>` plus `data-hovercard-type="user"`.
That's the primary signal, backed up by the `[bot]` login suffix.

Review tools that authenticate through an **OAuth app** post as ordinary user
accounts and carry no marker at all. Name those logins in the extension's
popup (click the toolbar icon).

## The part that's easy to get wrong

The tempting implementation is one CSS rule:

```css
.js-timeline-item:has(a.author[href^="/apps/"]) { display: none; }
```

It's wrong. On the PR used as a test fixture, 5 of 17 timeline items are a bot
thread that a human replied inside — that rule silently eats 9 human replies,
which is worse than not filtering at all.

So the unit of work is one comment by one author — but GitHub has no single
class for that. Most comments are a `.timeline-comment-group`; some partials
(code scanning, code quality) emit a bare `.js-comment` instead, and the two
nest, since a review wrapper can hold ten comments. The unit is therefore the
**innermost** of either, verified across every fixture to hold exactly one
author.

Wrappers nest too (a thread sits inside a timeline item), so `apply()` walks
them innermost-first and lets each claim the comments it owns — otherwise a
comment gets counted twice and collects two stubs.

Threads where a human spoke are never collapsed; the bot comments inside them
become a **"Show 3 bot comments"** stub, because a reply reading "good catch,
fixed" is meaningless without it.

The veto on collapsing a wrapper is `hasHuman()`, which scans author links
rather than units. That deliberately does not trust the segmentation above: if
GitHub ships another comment layout, the worst case is a bot comment that slips
through, never a human comment that gets swallowed.

GitHub streams the timeline in through `include-fragment` and re-renders on
Turbo navigation — on the Files tab only 2 of 27 comments exist in the initial
HTML. A `MutationObserver` is what makes this work at all.

## Tests

```
npm install
npm test
```

The fixtures are verbatim HTML from real PRs:

- **`pr-conversation.html`** — 43 comments, 25 from three review bots and 18
  from one human, tangled across 13 threads where the human replied under a bot.
- **`pr-files.html`** — the Files tab, where only 2 of 27 comments exist before
  scrolling, so it exercises the `MutationObserver` path.
- **`pr-code-quality.html`** — 32 bot comments from 12 vendors, including
  `github-code-quality`, whose bare-`.js-comment` layout an earlier version
  missed entirely.

The two assertions that matter are **hides no human** and **leaks no bot**. The
first is checked against every `a.author` link on the page rather than against
the extension's own comment segmentation, so a segmentation bug can't hide the
very failure the test exists to catch.

This suite is also the canary for GitHub changing their markup. To refresh:

```
curl -sL -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36" \
  https://github.com/OWNER/REPO/pull/N > test/fixtures/pr-conversation.html
```

## Files

| Path | What it does |
| --- | --- |
| `src/content.js` | All the logic: classify, hide, stub, observe |
| `src/content.css` | Hidden state, stubs, the chip |
| `src/background.js` | Keyboard shortcut → flips the shared flag |
| `src/popup.html` / `.js` | Toolbar popup: denylist for OAuth-app bots |
| `test/run.mjs` | Runs the real content script over saved PR HTML |

## Next

The thing v0 does *not* solve: bots re-post near-identical findings on every
push. Hash comment bodies per `(path, line)` and collapse repeats into one entry
with a "repeated 4×" badge. That needs the API (`/pulls/{n}/comments` carries
`path`, `line`, and `in_reply_to_id`), which means a token in
`chrome.storage.local` — still no server, and 5,000 requests/hour per user.
