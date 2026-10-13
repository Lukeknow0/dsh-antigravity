import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('settings render provider pause and suspended authorization distinctly', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let page;
  const status = {version:'0.1.5', schedulingMode:'manual', requestPauseRemainingMs:120000,
    accounts:[{id:'local',email:'user@example.test',suspended:true}], activeAccountId:'local'};
  let stateIndex=0;
  const React = {
    createElement(type, props, ...children) {return {type,props,children};},
    useMemo(fn) {return fn();}, useEffect() {}, useRef() {return {};}, useCallback(fn) {return fn;},
    useState(initial) {return [stateIndex++ === 0 ? status : initial, () => {}];},
  };
  vm.runInNewContext(source.replace('inject: ["slots", "locale"],','AntigravitySettingsPage, inject: ["slots", "locale"],'), {
    navigator:{language:'zh-CN'}, window:{__ModuleLoader__:{load({factory}){page=factory(()=>React).AntigravitySettingsPage;}}},
  });
  const output=JSON.stringify(page({ctx:{}}));
  assert.match(output,/请求已暂停，剩余 120 秒/);
  assert.match(output,/授权已暂停，请重新登录/);
  assert.doesNotMatch(output,/\"children\":\[\"已登录\"\]/);
});

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
