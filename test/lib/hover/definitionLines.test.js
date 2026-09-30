'use strict';
const { layout } = require('../../../webresources/definition-lines');
const { check, section, summary } = require('../help/helpers');

section('Numbered source layout');
const text = 'Name := function()\r\n  if flag then\r\n    value := "a\r\nb";\r\n\r\n    return value;\r\n  fi;\r\nend;';
const stringStart = text.indexOf('"a');
const symbolStart = text.indexOf('value');
const tokens = [
    { id: 0, start: symbolStart, end: symbolStart + 5, kind: 'variable', name: 'value' },
    { id: 1, start: stringStart, end: text.indexOf('";') + 1, kind: 'string' },
];
const lines = layout({ text, tokens, startRow: 98, row: 100 });
check('numbers begin at the excerpt rather than the declaration name', 99, lines[0].number);
check('line numbers continue through blank lines and digit boundaries', 106, lines.at(-1).number);
check('layout preserves exact original CRLF and multiline text', text,
    lines.map(line => line.segments.map(segment => segment.text).join('') + line.ending).join(''));
check('indent guides reflect nested two-space columns', [0, 1, 2],
    lines.slice(0, 3).map(line => line.guides));
check('cross-line syntax segments keep the same token identity', [1, 1],
    lines.flatMap(line => line.segments.filter(segment => segment.token?.id === 1)
        .map(segment => segment.token.id)));
check('clickable symbol identity survives line layout', 'value',
    lines[2].segments.find(segment => segment.token?.id === 0).token.name);
check('unindented multiline string content does not get extra guides', 0, lines[3].guides);
const blank = layout({ text: '  before\n\n\n  after', tokens: [], startRow: 0 });
check('indentation continues across a sequence of blank lines', [1, 1, 1, 1], blank.map(line => line.guides));
check('tabs reach their two-column tab stops', 2,
    layout({ text: '\t \tvalue', tokens: [], startRow: 0 })[0].guides);
check('whitespace-only lines retain their original text', '\t  ',
    layout({ text: '\t  ', tokens: [] })[0].segments[0].text);
check('trailing newline retains a final empty numbered line', [8, 9],
    layout({ text: 'x;\n', tokens: [], startRow: 7 }).map(line => line.number));
check('empty previews still have a stable numbered line', 1,
    layout({ text: '', tokens: [], startRow: 0 }).length);
check('indentation guide output is bounded', 64,
    layout({ text: ' '.repeat(10000) + 'value', tokens: [] })[0].guides);
check('built-in signatures start at one, not the call site', 1,
    layout({ text: 'Size(...)', tokens: [], startRow: 0, row: 120 })[0].number);
summary();
