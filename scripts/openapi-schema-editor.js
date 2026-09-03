export function schema(name, lines) {
  return [`    ${name}:`, ...lines.map((line) => `      ${line}`)].join('\n');
}

export function replaceSchema(source, name, replacement) {
  const startMarker = `    ${name}:`;
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing OpenAPI schema ${name}`);
  const remainder = source.slice(start + startMarker.length);
  const next = remainder.search(/^    [A-Za-z0-9][A-Za-z0-9_-]*:$/mu);
  if (next < 0) throw new Error(`Cannot find end of OpenAPI schema ${name}`);
  const end = start + startMarker.length + next;
  return `${source.slice(0, start)}${replacement}\n${source.slice(end)}`;
}

export function insertBefore(source, nextName, replacement) {
  const marker = `    ${nextName}:`;
  const index = source.indexOf(marker);
  if (index < 0) throw new Error(`Missing OpenAPI insertion point ${nextName}`);
  return `${source.slice(0, index)}${replacement}\n${source.slice(index)}`;
}
