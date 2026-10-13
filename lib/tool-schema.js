const MAX_SCHEMA_DEPTH = 128;
const MAX_SCHEMA_NODES = 50_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

const REFERENCE_KEYWORDS = new Set(['$ref', '$dynamicRef', '$recursiveRef']);

const SCHEMA_CHILDREN = new Map([
  ['properties', 'map'],
  ['patternProperties', 'map'],
  ['$defs', 'map'],
  ['definitions', 'map'],
  ['dependentSchemas', 'map'],
  ['dependencies', 'dependencies'],
  ['items', 'schema-or-map'],
  ['additionalItems', 'schema'],
  ['additionalProperties', 'schema'],
  ['unevaluatedProperties', 'schema'],
  ['propertyNames', 'schema'],
  ['contains', 'schema'],
  ['unevaluatedItems', 'schema'],
  ['not', 'schema'],
  ['if', 'schema'],
  ['then', 'schema'],
  ['else', 'schema'],
  ['contentSchema', 'schema'],
  ['prefixItems', 'array'],
  ['allOf', 'array'],
  ['anyOf', 'array'],
  ['oneOf', 'array'],
]);

const LEGACY_ANNOTATIONS = new Set([
  '$schema', '$id', '$anchor', '$dynamicAnchor', '$comment', 'title', 'examples',
  'default', 'deprecated', 'readOnly', 'writeOnly', 'contentEncoding', 'contentMediaType',
]);
const LEGACY_SUPPORTED = new Set(['type', 'description', 'properties', 'required', 'items', 'enum']);
const LEGACY_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);

export class ToolSchemaError extends Error {
  constructor(message, toolName, pointer) {
    super(`${message} (tool ${toolName ?? '<unknown>'} at ${pointer || '/'})`);
    this.name = 'ToolSchemaError';
    this.code = 'INVALID_TOOL_SCHEMA';
    this.toolName = toolName;
    this.pointer = pointer || '/';
  }
}

function pointerJoin(pointer, token) {
  return `${pointer}/${String(token).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function fail(message, toolName, pointer) {
  throw new ToolSchemaError(message, toolName, pointer);
}

function ownData(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function jsonStringBytes(value) {
  let bytes = 2; // surrounding quotes
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code < 0x20) {
      bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : code < 0x20 ? 6 : 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

function chargeClone(budget, bytes, pointer, toolName) {
  budget.nodes++;
  budget.bytes += bytes;
  if (budget.nodes > MAX_SCHEMA_NODES) fail('Schema node count exceeds the maximum', toolName, pointer);
  if (budget.bytes > MAX_JSON_BYTES) fail('Tool schema JSON exceeds the maximum byte size', toolName, pointer);
}

function safeClone(value, toolName, pointer, budget, ancestors = new WeakSet(), depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH) fail('Schema nesting exceeds the maximum depth', toolName, pointer);
  if (value === null) { chargeClone(budget, 4, pointer, toolName); return value; }
  if (typeof value === 'string') { chargeClone(budget, jsonStringBytes(value), pointer, toolName); return value; }
  if (typeof value === 'boolean') { chargeClone(budget, value ? 4 : 5, pointer, toolName); return value; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Schema data must contain finite JSON numbers', toolName, pointer);
    chargeClone(budget, Buffer.byteLength(JSON.stringify(value)), pointer, toolName);
    return value;
  }
  if (typeof value !== 'object') fail('Schema data must be JSON-compatible', toolName, pointer);
  if (ancestors.has(value)) fail('Native circular objects are not supported', toolName, pointer);
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    if (value.length > MAX_SCHEMA_NODES) fail('Schema node count exceeds the maximum', toolName, pointer);
    chargeClone(budget, 2, pointer, toolName);
    result = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) fail('Sparse arrays are not JSON-compatible', toolName, pointerJoin(pointer, index));
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('Accessor properties are not supported', toolName, pointerJoin(pointer, index));
      if (index) chargeClone(budget, 1, pointer, toolName);
      result.push(safeClone(descriptor.value, toolName, pointerJoin(pointer, index), budget, ancestors, depth + 1));
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    const crossRealmPlain = prototype !== null && Object.getPrototypeOf(prototype) === null;
    if (prototype !== null && prototype !== Object.prototype && !crossRealmPlain) fail('Schema objects must be plain JSON objects', toolName, pointer);
    chargeClone(budget, 2, pointer, toolName);
    result = {};
    let first = true;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail('Symbol keys are not JSON-compatible', toolName, pointer);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (!Object.hasOwn(descriptor, 'value')) fail('Accessor properties are not supported', toolName, pointerJoin(pointer, key));
      chargeClone(budget, jsonStringBytes(key) + 1 + (first ? 0 : 1), pointerJoin(pointer, key), toolName);
      first = false;
      Object.defineProperty(result, key, {
        value: safeClone(descriptor.value, toolName, pointerJoin(pointer, key), budget, ancestors, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  ancestors.delete(value);
  return result;
}

function resolveLocalReference(reference, root, toolName, pointer) {
  if (typeof reference !== 'string' || !reference.startsWith('#')) fail('Only local JSON Schema references are supported', toolName, pointer);
  let decoded;
  try {
    decoded = decodeURIComponent(reference.slice(1));
  } catch {
    fail('Invalid percent encoding in local reference', toolName, pointer);
  }
  if (decoded === '') return root;
  if (!decoded.startsWith('/')) fail('Local reference must use a JSON Pointer fragment', toolName, pointer);
  const tokens = decoded.slice(1).split('/').map(token => {
    if (/~(?![01])/.test(token)) fail('Invalid JSON Pointer escape in local reference', toolName, pointer);
    return token.replaceAll('~1', '/').replaceAll('~0', '~');
  });
  let current = root;
  for (const token of tokens) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, token)) {
      fail('Local reference does not resolve', toolName, pointer);
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, token);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('Reference target must use own data properties', toolName, pointer);
    current = descriptor.value;
  }
  if (current === null || typeof current !== 'object' && typeof current !== 'boolean') {
    fail('Local reference target is not a schema', toolName, pointer);
  }
  return current;
}

function* schemaChildren(schema, toolName, pointer) {
  for (const [keyword, kind] of SCHEMA_CHILDREN) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const value = ownData(schema, keyword);
    const childPointer = pointerJoin(pointer, keyword);
    if (kind === 'schema') yield [value, childPointer];
    else if (kind === 'map') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${keyword} must be an object`, toolName, childPointer);
      for (const key of Object.keys(value)) yield [ownData(value, key), pointerJoin(childPointer, key)];
    } else if (kind === 'dependencies') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('dependencies must be an object', toolName, childPointer);
      for (const name of Object.keys(value)) {
        const entry = ownData(value, name);
        if (Array.isArray(entry)) {
          if (entry.some(item => typeof item !== 'string')) fail('Property dependency must contain strings', toolName, pointerJoin(childPointer, name));
        } else yield [entry, pointerJoin(childPointer, name)];
      }
    } else if (kind === 'array') {
      if (!Array.isArray(value)) fail(`${keyword} must be an array`, toolName, childPointer);
      for (let index = 0; index < value.length; index++) yield [ownData(value, index), pointerJoin(childPointer, index)];
    } else if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) yield [ownData(value, index), pointerJoin(childPointer, index)];
    } else yield [value, childPointer];
  }
}

function validateSchema(root, toolName, schemaBudget) {
  const visited = new WeakSet();
  const resourceRoots = new WeakMap();
  const mapResources = (schema, resource) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
    if (Object.hasOwn(schema, '$id')) {
      if (typeof schema.$id !== 'string' || !schema.$id) fail('$id must be a nonempty string', toolName, '/parameters');
      resource = schema;
    }
    resourceRoots.set(schema, resource);
    for (const [child] of schemaChildren(schema, toolName, '/parameters')) mapResources(child, resource);
  };
  mapResources(root, root);
  const visit = (schema, pointer, depth) => {
    if (depth > MAX_SCHEMA_DEPTH) fail('Schema nesting exceeds the maximum depth', toolName, pointer);
    if (typeof schema === 'boolean') return;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) fail('Schema position must contain a JSON Schema object or boolean', toolName, pointer);
    if (visited.has(schema)) return;
    visited.add(schema);
    schemaBudget.count++;
    if (schemaBudget.count > MAX_SCHEMA_NODES) fail('Schema node count exceeds the maximum', toolName, pointer);

    for (const key of Object.keys(schema)) {
      const childPointer = pointerJoin(pointer, key);
      const value = ownData(schema, key);
      if (REFERENCE_KEYWORDS.has(key)) {
        const target = resolveLocalReference(value, resourceRoots.get(schema) || root, toolName, childPointer);
        visit(target, childPointer, depth + 1);
      }
    }
    for (const [child, childPointer] of schemaChildren(schema, toolName, pointer)) visit(child, childPointer, depth + 1);
  };
  visit(root, '/parameters', 0);
}

function legacySchema(root, schema, toolName, pointer, budget, refStack = new Set(), depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH) fail('Legacy expansion exceeds maximum depth', toolName, pointer);
  chargeClone(budget, 2, pointer, toolName);
  if (Object.hasOwn(schema, '$id')) root = schema;
  if (typeof schema === 'boolean') fail('Boolean schemas cannot be represented by the legacy format', toolName, pointer);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) fail('Schema position must contain a JSON Schema object', toolName, pointer);
  if (Object.hasOwn(schema, '$ref')) {
    const referencePointer = pointerJoin(pointer, '$ref');
    const target = resolveLocalReference(ownData(schema, '$ref'), root, toolName, referencePointer);
    if (refStack.has(target)) fail('Recursive references cannot be represented by the legacy format', toolName, referencePointer);
    const nextStack = new Set(refStack);
    nextStack.add(target);
    const resolved = legacySchema(root, target, toolName, pointer, budget, nextStack, depth + 1);
    const siblings = Object.keys(schema).filter(key => key !== '$ref' && key !== 'description' && !LEGACY_ANNOTATIONS.has(key));
    if (siblings.length) fail('Reference siblings cannot be represented without loss', toolName, pointerJoin(pointer, siblings[0]));
    if (schema.description !== undefined) resolved.description = schema.description;
    return resolved;
  }
  const result = {};
  for (const key of Object.keys(schema)) {
    const value = ownData(schema, key);
    const childPointer = pointerJoin(pointer, key);
    chargeClone(budget, jsonStringBytes(key), childPointer, toolName);
    if (LEGACY_ANNOTATIONS.has(key) || key === '$defs' || key === 'definitions') continue;
    if (!LEGACY_SUPPORTED.has(key)) fail('Schema keyword cannot be represented by the legacy format', toolName, childPointer);
    if (key === 'type') {
      let type = value;
      if (Array.isArray(type)) {
        if (type.length === 2 && type.includes('null')) type = type.find(item => item !== 'null');
        else fail('Union types cannot be represented by the legacy format', toolName, childPointer);
      }
      if (!LEGACY_TYPES.has(type)) fail('Schema type cannot be represented by the legacy format', toolName, childPointer);
      result.type = type;
    } else if (key === 'description') {
      if (typeof value !== 'string') fail('Schema description must be a string', toolName, childPointer);
      chargeClone(budget, jsonStringBytes(value), childPointer, toolName);
      result.description = value;
    } else if (key === 'enum') {
      if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string')) fail('Only string enums are supported by the legacy format', toolName, childPointer);
      result.enum = safeClone(value, toolName, childPointer, budget);
    } else if (key === 'required') {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail('required must be an array of strings', toolName, childPointer);
      result.required = safeClone(value, toolName, childPointer, budget);
    } else if (key === 'properties') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('properties must be an object', toolName, childPointer);
      const properties = {};
      for (const name of Object.keys(value)) {
        Object.defineProperty(properties, name, {
          value: legacySchema(root, ownData(value, name), toolName, pointerJoin(childPointer, name), budget, refStack, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      result.properties = properties;
    } else if (key === 'items') {
      if (Array.isArray(value)) fail('Tuple items cannot be represented by the legacy format', toolName, childPointer);
      result.items = legacySchema(root, value, toolName, childPointer, budget, refStack, depth + 1);
    }
  }
  return result;
}

export function convertToolDeclarations(tools, legacy = false) {
  if (!Array.isArray(tools)) fail('Tools must be an array', undefined, '/tools');
  const clonedTools = [];
  const schemaBudget = { count: 0 };
  let jsonBytes = 2; // []
  const cloneBudget = {nodes:0, bytes:2};
  const legacyBudget = {nodes:0, bytes:2};
  for (let index = 0; index < tools.length; index++) {
    const original = tools[index];
    const name = original && typeof original === 'object' && typeof ownData(original, 'name') === 'string'
      ? ownData(original, 'name') : undefined;
    if (!original || typeof original !== 'object' || Array.isArray(original)) fail('Tool declaration must be an object', name, `/tools/${index}`);
    const wire = {};
    for (const field of ['name', 'description', 'parameters']) {
      const descriptor = Object.getOwnPropertyDescriptor(original, field);
      if (descriptor && !Object.hasOwn(descriptor, 'value')) fail('Accessor properties are not supported', name, `/tools/${index}/${field}`);
      if (descriptor?.value !== undefined) wire[field] = descriptor.value;
    }
    const cloned = safeClone(wire, name, `/tools/${index}`, cloneBudget);
    if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) fail('Tool declaration must be an object', name, `/tools/${index}`);
    if (typeof cloned.name !== 'string' || cloned.name.length === 0) fail('Tool name must be a non-empty string', name, `/tools/${index}/name`);
    if (cloned.description !== undefined && typeof cloned.description !== 'string') fail('Tool description must be a string', cloned.name, `/tools/${index}/description`);
    const parameters = cloned.parameters === undefined
      ? { type: 'object', properties: {} }
      : cloned.parameters;
    jsonBytes += Buffer.byteLength(JSON.stringify(cloned), 'utf8') + (index === 0 ? 0 : 1);
    if (jsonBytes > MAX_JSON_BYTES) fail('Tool schema JSON exceeds the maximum byte size', cloned.name, '/parameters');
    validateSchema(parameters, cloned.name, schemaBudget);
    clonedTools.push({ name: cloned.name, description: cloned.description, parameters });
  }
  const declarations = [];
  for (const item of clonedTools) {
    const declaration = { name: item.name };
    if (item.description !== undefined) declaration.description = item.description;
    if (legacy) {
      declaration.parameters = legacySchema(item.parameters, item.parameters, item.name, '/parameters', legacyBudget);
    } else {
      declaration.parametersJsonSchema = item.parameters;
    }
    declarations.push(declaration);
  }
  return declarations;
}
