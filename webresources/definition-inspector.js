/* Read-only source rendering. GAP source and comments are never HTML. */
(() => {
    'use strict';
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    let session;
    let epoch = -1;

    function render(previews) {
        let selected = 0;
        const view = document.createElement('section');
        view.className = 'source-view';
        const header = document.createElement('header');
        header.className = 'preview-header';
        const heading = document.createElement('div');
        heading.className = 'heading';
        const title = document.createElement('strong');
        const category = document.createElement('span');
        category.className = 'category';
        heading.append(title, category);
        const source = document.createElement('button');
        source.title = 'Open source';
        source.setAttribute('aria-label', 'Open source');
        const icon = document.createElement('i');
        icon.className = 'codicon codicon-go-to-file';
        source.appendChild(icon);
        const navigate = () => vscode.postMessage({ type: 'source', session, epoch, index: selected });
        source.addEventListener('click', navigate);
        header.append(heading, source);
        const location = document.createElement('div');
        location.className = 'location';
        const file = document.createElement('button');
        file.className = 'source-link';
        file.addEventListener('click', navigate);
        location.appendChild(file);
        const code = document.createElement('pre');
        code.className = 'code';
        code.setAttribute('aria-label', 'Source definition');
        const comments = document.createElement('div');
        comments.className = 'comments';
        function choose(index) {
            selected = index;
            const preview = previews[index];
            title.textContent = preview.title;
            category.textContent = preview.category;
            file.textContent = preview.builtin ? preview.sourceLabel :
                `${preview.sourceLabel}:${preview.row + 1}`;
            file.title = preview.uri;
            source.title = preview.builtin ? 'Open GAP Help' : 'Open source';
            source.setAttribute('aria-label', source.title);
            code.replaceChildren();
            let offset = 0;
            for (const token of preview.tokens) {
                if (token.start < offset || token.end < token.start || token.end > preview.text.length) continue;
                code.appendChild(document.createTextNode(preview.text.slice(offset, token.start)));
                const span = document.createElement('span');
                span.className = `syntax-${token.kind}`;
                span.textContent = preview.text.slice(token.start, token.end);
                code.appendChild(span);
                offset = token.end;
            }
            code.appendChild(document.createTextNode(preview.text.slice(offset)));
            comments.textContent = preview.comments.join('\n');
            comments.hidden = !preview.comments.length;
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
            choices.addEventListener('change', () => choose(Number(choices.value)));
            location.appendChild(choices);
        }
        view.append(header, location, code, comments);
        choose(0);
        root.replaceChildren(view);
    }

    window.addEventListener('message', event => {
        const message = event.data;
        if (!message || typeof message !== 'object' ||
            (session && message.session !== session) || message.epoch < epoch) return;
        session = message.session;
        epoch = message.epoch;
        if (message.type === 'definition' && message.previews?.length) render(message.previews);
        else {
            const state = document.createElement('p');
            state.className = 'state';
            state.textContent = message.type === 'loading' ? 'Loading definition...' : 'No static definition found.';
            root.replaceChildren(state);
        }
    });
    vscode.postMessage({ type: 'ready' });
})();
