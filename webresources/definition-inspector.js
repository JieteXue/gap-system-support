/* Interactive source information, rendered exclusively as text and local icons. */
(() => {
    'use strict';
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    const cursor = document.getElementById('cursor-location');
    const follow = document.getElementById('follow');
    const refresh = document.getElementById('refresh');
    let session;
    let epoch = -1;
    let following = true;
    let active = true;
    const saved = vscode.getState?.() ?? {};
    const sections = new Map();
    let candidateKey;
    let selected = 0;

    function send(type, data = {}) {
        if (active || type === 'follow' || type === 'refresh') {
            vscode.postMessage({ type, session, epoch, ...data });
        }
    }

    function iconButton(icon, label, action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.title = label;
        button.setAttribute('aria-label', label);
        const glyph = document.createElement('i');
        glyph.className = `codicon codicon-${icon}`;
        button.appendChild(glyph);
        button.addEventListener('click', action);
        return button;
    }

    function section(id, title, open) {
        const details = document.createElement('details');
        details.className = 'info-section';
        details.open = saved[id] ?? open;
        const summary = document.createElement('summary');
        summary.textContent = title;
        const body = document.createElement('div');
        body.className = 'section-body';
        details.append(summary, body);
        details.addEventListener('toggle', () => {
            saved[id] = details.open;
            vscode.setState?.(saved);
        });
        root.appendChild(details);
        sections.set(id, { details, summary, body, key: undefined });
    }

    root.replaceChildren();
    section('definition', 'Definition', true);
    section('locals', 'Local Context', true);
    section('messages', 'Messages', true);
    section('all', 'All Messages', false);

    function updateSection(id, title, model, render) {
        const item = sections.get(id);
        item.summary.textContent = title;
        const key = JSON.stringify(model);
        if (item.key === key) return;
        item.key = key;
        render(item.body);
    }

    function state(body, text) {
        const message = document.createElement('p');
        message.className = 'state';
        message.textContent = text;
        body.replaceChildren(message);
    }

    function definition(body, previews) {
        if (!previews.length) { state(body, 'No static definition at this position.'); return; }
        const key = previews.map(view => `${view.uri}:${view.row}:${view.column}`).join('|');
        if (candidateKey !== key) selected = 0;
        candidateKey = key;
        selected = Math.min(selected, previews.length - 1);
        const view = document.createElement('div');
        const header = document.createElement('header');
        header.className = 'preview-header';
        const heading = document.createElement('div');
        heading.className = 'heading';
        const title = document.createElement('strong');
        const category = document.createElement('span');
        category.className = 'category';
        heading.append(title, category);
        const controls = document.createElement('nav');
        const source = iconButton('go-to-file', 'Open source', () => send('source', { index: selected }));
        controls.append(source, iconButton('references', 'Find references', () => send('references')));
        header.append(heading, controls);
        const location = document.createElement('div');
        location.className = 'location';
        const file = document.createElement('button');
        file.className = 'source-link';
        file.addEventListener('click', () => send('source', { index: selected }));
        location.appendChild(file);
        const code = document.createElement('pre');
        code.className = 'code';
        code.setAttribute('aria-label', 'Source definition');
        code.addEventListener('copy', event => {
            const selection = window.getSelection();
            if (!event.clipboardData || !selection?.rangeCount) return;
            const range = selection.getRangeAt(0);
            if (!code.contains(range.startContainer) || !code.contains(range.endContainer)) return;
            // Block layout adds visual line breaks; copy the original source text nodes.
            event.clipboardData.setData('text/plain', range.cloneContents().textContent);
            event.preventDefault();
        });
        const comments = document.createElement('div');
        comments.className = 'comments';
        function choose(index) {
            selected = index;
            const preview = previews[index];
            const scrollLeft = code.scrollLeft;
            title.textContent = preview.title;
            category.textContent = preview.category;
            file.textContent = preview.builtin ? preview.sourceLabel :
                `${preview.sourceLabel}:${preview.row + 1}`;
            file.title = preview.uri;
            source.title = preview.builtin ? 'Open GAP Help' : 'Open source';
            source.setAttribute('aria-label', source.title);
            code.replaceChildren();
            const lines = GAPDefinitionLines.layout(preview);
            code.dataset.digits = String(String(lines.at(-1).number).length);
            for (const line of lines) {
                const row = document.createElement('span');
                row.className = 'code-line';
                const number = document.createElement('span');
                number.className = 'line-number';
                number.dataset.line = String(line.number);
                number.setAttribute('aria-hidden', 'true');
                const content = document.createElement('span');
                content.className = 'line-content';
                const guides = document.createElement('span');
                guides.className = 'indent-guides';
                guides.setAttribute('aria-hidden', 'true');
                for (let level = 0; level < line.guides; level++) {
                    const guide = document.createElement('span');
                    guide.className = 'indent-guide';
                    guides.appendChild(guide);
                }
                content.appendChild(guides);
                for (const segment of line.segments) appendSegment(content, segment, preview);
                row.append(number, content);
                code.appendChild(row);
                if (line.ending) {
                    const ending = document.createElement('span');
                    ending.className = 'line-ending';
                    ending.textContent = line.ending;
                    code.appendChild(ending);
                }
            }
            code.scrollLeft = scrollLeft;
            comments.textContent = preview.comments.join('\n');
            comments.hidden = !preview.comments.length;
        }
        function appendSegment(content, segment, preview) {
            const token = segment.token;
            if (token) {
                const span = document.createElement('span');
                span.className = `syntax-${token.kind}`;
                span.textContent = segment.text;
                if (token.name && !preview.builtin) {
                    span.classList.add('symbol');
                    span.tabIndex = 0;
                    span.setAttribute('role', 'link');
                    span.title = `Go to definition: ${token.name}`;
                    span.setAttribute('aria-label', span.title);
                    const navigate = () => send('symbol', { index: selected, token: token.id });
                    span.addEventListener('click', navigate);
                    span.addEventListener('keydown', event => {
                        if (event.key === 'Enter') { event.preventDefault(); navigate(); }
                    });
                }
                content.appendChild(span);
            } else content.appendChild(document.createTextNode(segment.text));
        }
        if (previews.length > 1) {
            const choices = document.createElement('select');
            choices.setAttribute('aria-label', 'Definition origin');
            previews.forEach((candidate, index) => {
                const option = document.createElement('option');
                option.value = String(index);
                option.textContent = `${index + 1}. ${candidate.sourceLabel}:${candidate.row + 1}`;
                choices.appendChild(option);
            });
            choices.value = String(selected);
            choices.addEventListener('change', () => choose(Number(choices.value)));
            location.appendChild(choices);
        }
        view.append(header, location, code, comments);
        choose(selected);
        body.replaceChildren(view);
    }

    function locals(body, context) {
        if (!context?.local) { state(body, 'No source context.'); return; }
        const scope = document.createElement('div');
        scope.className = 'scope-name';
        scope.textContent = context.local.scope;
        const list = document.createElement('div');
        list.className = 'bindings';
        context.local.bindings.forEach((binding, index) => {
            const row = document.createElement('button');
            row.className = 'binding';
            const name = document.createElement('span');
            name.textContent = binding.name;
            const kind = document.createElement('span');
            kind.className = 'category';
            kind.textContent = binding.kind;
            row.append(name, kind);
            row.title = `${context.sourceLabel}:${binding.row + 1}`;
            row.addEventListener('click', () => send('binding', { index }));
            list.appendChild(row);
        });
        body.replaceChildren(scope, list);
    }

    function messages(body, entries) {
        if (!entries.length) { state(body, 'No messages.'); return; }
        const list = document.createElement('div');
        entries.forEach(({ item, index }) => {
            const row = document.createElement('button');
            row.className = `diagnostic severity-${item.severity}`;
            const glyph = document.createElement('i');
            glyph.className = `codicon codicon-${['error', 'warning', 'info', 'lightbulb'][item.severity] ?? 'info'}`;
            const text = document.createElement('span');
            text.textContent = item.message;
            const location = document.createElement('span');
            location.className = 'category';
            location.textContent = `${item.row + 1}:${item.column + 1}`;
            row.append(glyph, text, location);
            row.addEventListener('click', () => send('diagnostic', { index }));
            list.appendChild(row);
        });
        body.replaceChildren(list);
    }

    cursor.addEventListener('click', () => send('context-source'));
    cursor.tabIndex = 0;
    cursor.setAttribute('role', 'link');
    cursor.title = 'Go to cursor location';
    cursor.addEventListener('keydown', event => {
        if (event.key === 'Enter') send('context-source');
    });
    follow.addEventListener('click', () => send('follow', { value: !following }));
    refresh.addEventListener('click', () => send('refresh'));

    window.addEventListener('message', event => {
        const message = event.data;
        if (!message || typeof message !== 'object' ||
            (session && message.session !== session) || message.epoch < epoch) return;
        session = message.session;
        epoch = message.epoch;
        following = message.following;
        active = !message.busy && message.type !== 'stale';
        root.inert = !active;
        root.classList.toggle('busy', !!message.busy);
        root.classList.toggle('stale', message.type === 'stale');
        root.setAttribute('aria-busy', String(!!message.busy));
        follow.title = following ? 'Pause cursor following' : 'Resume cursor following';
        follow.setAttribute('aria-label', follow.title);
        follow.setAttribute('aria-pressed', String(!following));
        follow.querySelector('i').className = `codicon codicon-${following ? 'debug-pause' : 'debug-continue'}`;
        cursor.setAttribute('aria-disabled', String(!active));
        if (message.busy) return;
        const context = message.context;
        cursor.textContent = context
            ? `${context.sourceLabel}:${context.row + 1}:${context.column + 1}` : 'GAP Info';
        if (message.type === 'stale') cursor.textContent += ' (source changed)';
        else if (!following) cursor.textContent += ' (paused)';
        updateSection('definition', 'Definition', message.previews ?? [], body =>
            definition(body, message.previews ?? []));
        const localModel = context ? { uri: context.uri, local: context.local } : null;
        updateSection('locals', 'Local Context', localModel, body => locals(body, context));
        const entries = (context?.diagnostics ?? []).map((item, index) => ({ item, index }));
        const current = entries.filter(entry => entry.item.current);
        updateSection('messages', `Messages (${current.length})`, current, body => messages(body, current));
        updateSection('all', `All Messages (${context?.diagnosticCount ?? 0})`, entries, body => messages(body, entries));
    });
    vscode.postMessage({ type: 'ready' });
})();
