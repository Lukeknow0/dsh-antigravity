import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('quota card renders unknown separately from actual zero and does not mix weekly and five-hour values', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let card;
  vm.runInNewContext(source.replace('inject: ["slots", "locale"],', 'QuotaCardRows, inject: ["slots", "locale"],'), {
    window: { __ModuleLoader__: { load({ factory }) {
      card = factory(() => ({ createElement(type, props, ...children) { return { type, props, children }; } })).QuotaCardRows;
    } } },
  });
  const tree = card({ quota: { groups: [{ displayName: 'Claude', buckets: [
    { displayName: 'Weekly', remainingFraction: 0.395 },
    { displayName: 'Five Hour', remainingFraction: null },
    { displayName: 'Actual Zero', remainingFraction: 0 },
  ] }] }, tr: key => key });
  const output = JSON.stringify(tree);
  assert.match(output, /39.5%/);
  assert.match(output, /quotaUnknown/);
  assert.match(output, /"0%"/);
  assert.doesNotMatch(output, /100%/);
  assert.doesNotMatch(output, /NaN/);
});
