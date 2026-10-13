import test from 'node:test';
import assert from 'node:assert/strict';
import { convertToolDeclarations, ToolSchemaError } from '../lib/tool-schema.js';

const tool = parameters => ({ name: 'inspect_address', description: 'Inspect an address', parameters });
const errorFor = (fn, pointer) => {
  assert.throws(fn, error => {
    assert.ok(error instanceof ToolSchemaError);
    assert.equal(error.code, 'INVALID_TOOL_SCHEMA');
    assert.equal(error.toolName, 'inspect_address');
    if (pointer !== undefined) assert.equal(error.pointer, pointer);
    return true;
  });
};

test('Gemini preserves complete definitions and local references without mutating input', () => {
  const parameters = {
    type: 'object',
    properties: { address: { $ref: '#/$defs/address' } },
    $defs: { address: { type: 'string', description: 'An address' } },
    definitions: { legacyAddress: { type: 'string' } },
    required: ['address'],
  };
  const before = JSON.stringify(parameters);
  const [declaration] = convertToolDeclarations([tool(parameters)]);
  assert.equal(declaration.name, 'inspect_address');
  assert.equal(declaration.parametersJsonSchema.$defs.address.type, 'string');
  assert.equal(declaration.parametersJsonSchema.properties.address.$ref, '#/$defs/address');
  assert.deepEqual(declaration.parametersJsonSchema.definitions, parameters.definitions);
  assert.equal(JSON.stringify(parameters), before);
});

test('Gemini preserves nested union and array schemas, including recursive local references', () => {
  const parameters = {
    type: 'object',
    properties: {
      nodes: { type: 'array', items: { anyOf: [{ type: 'string' }, { $ref: '#/$defs/node' }] } },
    },
    $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' } } } },
  };
  const [declaration] = convertToolDeclarations([tool(parameters)]);
  assert.deepEqual(declaration.parametersJsonSchema, parameters);
  assert.equal(declaration.parametersJsonSchema.$defs.node.properties.next.$ref, '#/$defs/node');
});

test('schema keywords used as property names are treated as data schemas only at schema positions', () => {
  const parameters = {
    type: 'object',
    properties: {
      type: { type: 'string' },
      description: { type: 'string' },
      $defs: { type: 'object', properties: { value: { type: 'number' } } },
      enum: { type: 'array', items: { type: 'string' } },
    },
  };
  const [declaration] = convertToolDeclarations([tool(parameters)]);
  assert.deepEqual(declaration.parametersJsonSchema, parameters);
});

test('missing parameters default to an empty object schema', () => {
  const [declaration] = convertToolDeclarations([{ name: 'empty' }]);
  assert.deepEqual(declaration.parametersJsonSchema, { type: 'object', properties: {} });
});

test('missing and external references fail locally with tool and pointer context', () => {
  errorFor(() => convertToolDeclarations([tool({ type: 'object', properties: { bad: { $ref: '#/$defs/nope' } } })]), '/parameters/properties/bad/$ref');
  errorFor(() => convertToolDeclarations([tool({ type: 'object', properties: { bad: { $ref: 'https://example.test/schema' } } })]), '/parameters/properties/bad/$ref');
});

test('reference pointers decode percent escapes and JSON Pointer escapes safely', () => {
  const parameters = {
    type: 'object',
    properties: { value: { $ref: '#/$defs/a~1b~0c' } },
    $defs: { 'a/b~c': { type: 'string' } },
  };
  const [declaration] = convertToolDeclarations([tool(parameters)]);
  assert.equal(declaration.parametersJsonSchema.properties.value.$ref, '#/$defs/a~1b~0c');
  const percentEncoded = { type: 'object', properties: { value: { $ref: '#/%24defs/a%7E0b' } }, '$defs': { 'a~b': { type: 'string' } } };
  assert.doesNotThrow(() => convertToolDeclarations([tool(percentEncoded)]));
});

test('native circular JavaScript objects fail with a safe pointer error', () => {
  const properties = {};
  const parameters = { type: 'object', properties };
  properties.self = parameters;
  errorFor(() => convertToolDeclarations([tool(parameters)]));
});

test('input objects are never modified during validation or conversion', () => {
  const parameters = { type: 'object', properties: { value: { type: 'string', default: { nested: true } } } };
  const before = structuredClone(parameters);
  convertToolDeclarations([tool(parameters)]);
  assert.deepEqual(parameters, before);
});

test('schema traversal enforces depth, node-count, and JSON-byte budgets', () => {
  let deep = { type: 'string' };
  for (let index = 0; index < 130; index++) deep = { type: 'array', items: deep };
  errorFor(() => convertToolDeclarations([tool(deep)]));

  const properties = {};
  for (let index = 0; index < 50_100; index++) properties[`p${index}`] = { type: 'string' };
  errorFor(() => convertToolDeclarations([tool({ type: 'object', properties })]));

  errorFor(() => convertToolDeclarations([tool({ type: 'object', properties: { value: { type: 'string', description: 'x'.repeat(2 * 1024 * 1024) } } })]));
});

test('legacy conversion expands local references and supports nullable single types', () => {
  const parameters = {
    type: 'object',
    properties: { address: { $ref: '#/$defs/address' }, note: { type: ['string', 'null'], description: 'Optional note' } },
    $defs: { address: { type: 'string', description: 'Address' } },
  };
  const [declaration] = convertToolDeclarations([tool(parameters)], true);
  assert.equal(declaration.parameters.properties.address.type, 'string');
  assert.equal(declaration.parameters.properties.address.description, 'Address');
  assert.equal(declaration.parameters.properties.note.type, 'string');
  assert.equal(declaration.parameters.properties.note.description, 'Optional note');
  assert.equal(declaration.parameters.$defs, undefined);
});

test('legacy conversion rejects lossy validation constraints', () => {
  errorFor(() => convertToolDeclarations([tool({ type: 'object', properties: { age: { type: 'integer', minimum: 0 } } })], true), '/parameters/properties/age/minimum');
  errorFor(() => convertToolDeclarations([tool({ type: 'string', enum: ['a', 'b'] })], true), '/parameters/enum');
});

test('legacy conversion rejects unions and recursive references instead of erasing them', () => {
  errorFor(() => convertToolDeclarations([tool({ anyOf: [{ type: 'string' }, { type: 'number' }] })], true), '/parameters/anyOf');
  errorFor(() => convertToolDeclarations([tool({ type: 'object', properties: { next: { $ref: '#/$defs/node' } }, $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' } } } } })], true));
});

test('prototype-named reference tokens resolve only own keys', () => {
  errorFor(() => convertToolDeclarations([tool({ type: 'object', properties: { bad: { $ref: '#/constructor/prototype' } } })]), '/parameters/properties/bad/$ref');
  const parameters = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}');
  const [declaration] = convertToolDeclarations([tool(parameters)]);
  assert.equal(Object.hasOwn(declaration.parametersJsonSchema.properties, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(declaration.parametersJsonSchema.properties), Object.prototype);
});

test('invalid tool metadata fails with a tool pointer and never echoes schema values', () => {
  assert.throws(() => convertToolDeclarations([{ name: 'safe', parameters: 'SECRET_SCHEMA_VALUE' }]), error => {
    assert.equal(error.code, 'INVALID_TOOL_SCHEMA');
    assert.equal(error.toolName, 'safe');
    assert.match(error.pointer, /^\/parameters/);
    assert.doesNotMatch(error.message, /SECRET_SCHEMA_VALUE/);
    return true;
  });
});
