const input = document.getElementById('input');
const addButton = document.getElementById('add');
const list = document.getElementById('list');
const empty = document.getElementById('empty');
const status = document.getElementById('status');

let denylist = [];
let statusTimer = null;

function normalize(raw) {
	return raw.trim().replace(/^@/, '');
}

function render() {
	list.innerHTML = '';
	for (const login of denylist) {
		const li = document.createElement('li');
		const name = document.createElement('span');
		name.textContent = login;
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.title = `Remove ${login}`;
		remove.setAttribute('aria-label', `Remove ${login}`);
		remove.textContent = '×';
		remove.addEventListener('click', () => {
			denylist = denylist.filter((l) => l !== login);
			save();
		});
		li.append(name, remove);
		list.appendChild(li);
	}
	empty.classList.toggle('is-hidden', denylist.length > 0);
}

function flashStatus(text) {
	status.textContent = text;
	clearTimeout(statusTimer);
	statusTimer = setTimeout(() => {
		status.textContent = '';
	}, 1500);
}

async function save() {
	await chrome.storage.local.set({ denylist });
	render();
	flashStatus('Saved');
}

function addFromInput() {
	const login = normalize(input.value);
	if (!login || denylist.includes(login)) {
		input.value = '';
		addButton.disabled = true;
		return;
	}
	denylist.push(login);
	input.value = '';
	addButton.disabled = true;
	save();
}

input.addEventListener('input', () => {
	addButton.disabled = normalize(input.value).length === 0;
});

input.addEventListener('keydown', (event) => {
	if (event.key === 'Enter' && !addButton.disabled) addFromInput();
});

addButton.addEventListener('click', addFromInput);

chrome.storage.local.get('denylist').then(({ denylist: stored }) => {
	denylist = stored || [];
	render();
});
