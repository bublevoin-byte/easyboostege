import assert from 'node:assert/strict';

function cssLayer(source, name) {
  const marker = `@layer ${name} {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} layer`);
  const open = source.indexOf('{', start);
  let depth = 1;
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  assert.fail(`unterminated ${name} layer`);
}

export { cssLayer };
