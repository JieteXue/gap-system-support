/* Exact source ranges for line numbers, indentation guides, and syntax spans. */
(() => {
    'use strict';
    function layout(preview) {
        const parts = preview.text.split(/(\r\n|\n|\r)/);
        const lines = [];
        let start = 0;
        let tokenIndex = 0;
        for (let index = 0; index < parts.length; index += 2) {
            const text = parts[index];
            const ending = parts[index + 1] ?? '';
            const end = start + text.length;
            const segments = [];
            let offset = start;
            while (tokenIndex < preview.tokens.length && preview.tokens[tokenIndex].end <= start) tokenIndex++;
            for (let next = tokenIndex; next < preview.tokens.length; next++) {
                const token = preview.tokens[next];
                if (token.start >= end) break;
                if (token.end <= offset || token.end < token.start || token.end > preview.text.length) continue;
                const left = Math.max(offset, token.start);
                const right = Math.min(end, token.end);
                if (left > offset) segments.push({ text: preview.text.slice(offset, left) });
                if (right > left) segments.push({ text: preview.text.slice(left, right), token });
                offset = right;
            }
            if (offset < end) segments.push({ text: preview.text.slice(offset, end) });
            let columns = 0;
            for (const char of /^[ \t]*/.exec(text)[0]) {
                columns += char === '\t' ? 2 - columns % 2 : 1;
            }
            lines.push({
                number: (preview.startRow ?? preview.row ?? 0) + lines.length + 1,
                segments, ending, blank: !text.trim(), columns,
            });
            start = end + ending.length;
        }
        // Empty lines carry guides only where indentation continues on both sides.
        let previous = 0;
        let nextNonblank = 0;
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            if (!line.blank) {
                previous = line.columns;
            } else if (!line.columns) {
                if (nextNonblank <= index) {
                    nextNonblank = index + 1;
                    while (nextNonblank < lines.length && lines[nextNonblank].blank) nextNonblank++;
                }
                line.columns = Math.min(previous, lines[nextNonblank]?.columns ?? 0);
            }
            line.guides = Math.min(64, Math.floor(line.columns / 2));
        }
        return lines;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = { layout };
    else globalThis.GAPDefinitionLines = { layout };
})();
