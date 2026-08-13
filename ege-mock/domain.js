import crypto from 'node:crypto';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => key !== 'fingerprint' && value[key] !== undefined)
      .sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintEgeMockForm(form) {
  if (!form || typeof form !== 'object' || Array.isArray(form)) {
    throw new TypeError('EGE_MOCK_FORM_INVALID: form must be an object');
  }
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(form)).digest('hex')}`;
}
