import { parse, Allow } from 'partial-json';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

const validator = new AjvJsonSchemaValidator();
const validators = new WeakMap();

// Decode serialization wrappers, never eval model output or invent string values.
function unwrap(raw) {
  let value = raw;
  for (let i = 0; i < 3 && typeof value === 'string'; i++) {
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded !== 'string') break;
      value = decoded;
    } catch { break; }
  }
  // Some providers leave one JSON-string escaping layer without its wrapper.
  // Decode it only when adding serialization quotes produces valid JSON.
  if (typeof value === 'string' && /^\s*\{\\"/.test(value)) {
    try { value = JSON.parse('"' + value + '"'); } catch { /* Preserve ambiguous input. */ }
  }
  return value;
}

function missingParameters(value, schema, prefix = '') {
  if (!schema || !value || typeof value !== 'object' || Array.isArray(value)) return [];
  const missing = (schema.required || []).filter(key => !Object.hasOwn(value, key)).map(key => prefix + key);
  for (const [key, child] of Object.entries(schema.properties || {})) {
    if (Object.hasOwn(value, key)) missing.push(...missingParameters(value[key], child, prefix + key + '.'));
  }
  return missing;
}

// Recover partial containers only. Unfinished scalar values and arrays are
// omitted by partial-json, so they must be regenerated when required.
export function parseToolArgumentObject(raw) {
  const text = unwrap(raw);
  const args = parse(text, Allow.OBJ);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object');
  return args;
}

export function recoverToolArguments(raw, schema) {
  let args = {};
  let parsed = false, parseError;
  try {
    args = parseToolArgumentObject(raw); parsed = true;
    // partial-json can return a prefix even for invalid tokens in the middle.
    // Native JSON diagnostics distinguish those from an unfinished document.
    const text = unwrap(raw);
    try { JSON.parse(text); } catch (error) {
      const position = error.message.match(/position (\d+)/)?.[1];
      if (!/unexpected end|unterminated/i.test(error.message) && Number(position) !== text.length) {
        parsed = false; parseError = error.message;
      }
    }
  }
  catch (error) { parseError = error.message; }
  const report = { rawArguments: raw, recoveredArguments: args, missingRequired: [], invalidParameters: [], ready: false };
  report.missingRequired = missingParameters(args, schema);
  if (!schema) { report.validationError = 'Tool input schema is unavailable'; return report; }
  try {
    let validate = validators.get(schema);
    if (!validate) { validate = validator.getValidator(schema); validators.set(schema, validate); }
    const result = validate(args);
    report.validationError = parseError || result.errorMessage;
    report.ready = parsed && result.valid && report.missingRequired.length === 0;
  } catch { report.validationError = 'Tool input schema could not be validated'; }
  return report;
}
