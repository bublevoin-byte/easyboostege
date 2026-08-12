function splitFlow(source, separator = ',') {
  const parts = [];
  let quote = null;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index + 1] === quote) index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === '[' || character === '{') depth += 1;
    else if (character === ']' || character === '}') depth -= 1;
    else if (character === separator && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function flowPair(source) {
  let quote = null;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index + 1] === quote) index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === '[' || character === '{') depth += 1;
    else if (character === ']' || character === '}') depth -= 1;
    else if (character === ':' && depth === 0) return [source.slice(0, index).trim(), source.slice(index + 1).trim()];
  }
  throw new Error(`Unsupported YAML flow pair: ${source}`);
}

function scalar(source) {
  const value = source.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitFlow(value.slice(1, -1)).map(scalar);
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    return Object.fromEntries(splitFlow(value.slice(1, -1)).map((part) => {
      const [key, child] = flowPair(part);
      return [key, scalar(child)];
    }));
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/gu, "'");
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  return value;
}

function indentation(line) {
  return line.match(/^ */u)[0].length;
}

function mappingPair(source) {
  const index = source.indexOf(':');
  if (index < 0) throw new Error(`Unsupported YAML mapping line: ${source}`);
  return [source.slice(0, index).trim(), source.slice(index + 1).trim()];
}

function parseYamlBlock(lines, start = 0, indent = indentation(lines[start] || '')) {
  const sequence = lines[start]?.slice(indent).startsWith('- ');
  const value = sequence ? [] : {};
  let index = start;
  while (index < lines.length && indentation(lines[index]) === indent
    && lines[index].slice(indent).startsWith('- ') === sequence) {
    const content = lines[index].slice(indent + (sequence ? 2 : 0));
    if (sequence) {
      if (!content) {
        const parsed = parseYamlBlock(lines, index + 1, indentation(lines[index + 1]));
        value.push(parsed.value); index = parsed.index; continue;
      }
      if (content.includes(':')) {
        const item = {};
        const [key, rest] = mappingPair(content);
        if (rest) item[key] = scalar(rest);
        else {
          const parsed = parseYamlBlock(lines, index + 1, indentation(lines[index + 1]));
          item[key] = parsed.value; index = parsed.index - 1;
        }
        index += 1;
        if (index < lines.length && indentation(lines[index]) > indent
          && !lines[index].slice(indentation(lines[index])).startsWith('- ')) {
          const parsed = parseYamlBlock(lines, index, indentation(lines[index]));
          Object.assign(item, parsed.value); index = parsed.index;
        }
        value.push(item);
        continue;
      }
      value.push(scalar(content)); index += 1; continue;
    }

    const [key, rest] = mappingPair(content);
    if (/^[>|]/u.test(rest)) {
      const blockIndent = index + 1 < lines.length ? indentation(lines[index + 1]) : indent;
      const text = [];
      index += 1;
      while (index < lines.length && indentation(lines[index]) >= blockIndent && blockIndent > indent) {
        text.push(lines[index].slice(blockIndent)); index += 1;
      }
      value[key] = text.join(' ');
      continue;
    }
    if (rest) {
      value[key] = scalar(rest); index += 1; continue;
    }
    const parsed = parseYamlBlock(lines, index + 1, indentation(lines[index + 1]));
    value[key] = parsed.value; index = parsed.index;
  }
  return { value, index };
}

function schemaBlock(openapi, name) {
  const lines = openapi.replace(/\r/gu, '').split('\n');
  const start = lines.findIndex((line) => line === `    ${name}:`);
  if (start < 0) throw new Error(`Missing OpenAPI schema ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^ {4}[A-Za-z0-9][A-Za-z0-9_-]*:$/u.test(lines[end])) end += 1;
  const body = lines.slice(start + 1, end).filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  return parseYamlBlock(body).value;
}

function jsonSchema(value) {
  if (Array.isArray(value)) return value.map(jsonSchema);
  if (!value || typeof value !== 'object') return value;
  const converted = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSchema(child)]));
  if (converted.nullable === true) {
    delete converted.nullable;
    if (typeof converted.type === 'string') converted.type = [converted.type, 'null'];
    if (Array.isArray(converted.enum) && !converted.enum.includes(null)) converted.enum.push(null);
  }
  return converted;
}

function referencedSchemas(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((child) => referencedSchemas(child, found));
  else if (value && typeof value === 'object') {
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/components/schemas/')) {
      found.add(value.$ref.slice('#/components/schemas/'.length));
    }
    Object.values(value).forEach((child) => referencedSchemas(child, found));
  }
  return found;
}

export function compileOpenApiSchema(openapi, name) {
  const schemas = new Map();
  function collect(schemaName) {
    if (schemas.has(schemaName)) return;
    const schema = jsonSchema(schemaBlock(openapi, schemaName));
    schemas.set(schemaName, schema);
    referencedSchemas(schema).forEach(collect);
  }
  collect(name);
  function matches(schema, value, path, errors) {
    if (schema.$ref) {
      const reference = schema.$ref.slice('#/components/schemas/'.length);
      return matches(schemas.get(reference), value, path, errors);
    }
    if (schema.allOf && !schema.allOf.every((child) => matches(child, value, path, errors))) return false;
    if (schema.oneOf) {
      const count = schema.oneOf.filter((child) => matches(child, value, path, [])).length;
      if (count !== 1) { errors.push(`${path} must match exactly one branch; matched ${count}`); return false; }
    }
    if (schema.not && matches(schema.not, value, path, [])) {
      errors.push(`${path} matches a forbidden branch`); return false;
    }
    if (schema['x-easyboost-grammar-type-scores'] === 'session-items') {
      const items = value?.session?.items;
      const declared = value?.typeScores;
      if (!Array.isArray(items) || !declared || typeof declared !== 'object' || Array.isArray(declared)) return false;
      const actual = {};
      for (const item of items) {
        if (!actual[item.type]) actual[item.type] = { correct: 0, total: 0 };
        actual[item.type].total += 1;
        if (item.correct === true) actual[item.type].correct += 1;
      }
      const types = Object.keys(actual).sort();
      const declaredTypes = Object.keys(declared).sort();
      if (JSON.stringify(declaredTypes) !== JSON.stringify(types)
        || types.some((type) => declared[type]?.correct !== actual[type].correct
          || declared[type]?.total !== actual[type].total)) {
        errors.push(`${path}/typeScores must exactly equal counts from session.items`); return false;
      }
    }
    if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
      errors.push(`${path} is outside the enum`); return false;
    }
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      const normalized = actual === 'number' && Number.isInteger(value) ? ['integer', 'number'] : [actual];
      if (!types.some((type) => normalized.includes(type))) {
        errors.push(`${path} must have type ${types.join('|')}`); return false;
      }
    }
    if (typeof value === 'string') {
      if (schema.minLength != null && value.length < schema.minLength) return false;
      if (schema.maxLength != null && value.length > schema.maxLength) return false;
      if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) return false;
    }
    if (Array.isArray(value)) {
      if (schema.minItems != null && value.length < schema.minItems) return false;
      if (schema.maxItems != null && value.length > schema.maxItems) return false;
      if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
      if (schema.items && !value.every((item, index) => matches(schema.items, item, `${path}/${index}`, errors))) return false;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (schema.required && !schema.required.every((key) => Object.hasOwn(value, key))) return false;
      if (schema.properties && !Object.entries(schema.properties).every(([key, child]) => (
        !Object.hasOwn(value, key) || matches(child, value[key], `${path}/${key}`, errors)
      ))) return false;
      if (schema.additionalProperties === false
        && Object.keys(value).some((key) => !Object.hasOwn(schema.properties || {}, key))) return false;
    }
    return true;
  }
  const validate = (value) => {
    const errors = [];
    const accepted = matches(schemas.get(name), value, '#', errors);
    validate.errors = accepted ? null : errors;
    return accepted;
  };
  validate.errors = null;
  return validate;
}
