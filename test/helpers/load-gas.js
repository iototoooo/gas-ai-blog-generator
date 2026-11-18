/**
 * src/*.js を GAS と同じく「全ファイルが1つのグローバル空間を共有する」形で読み込む。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGasEnvironment } = require('./gas-mock');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');

function loadGas(opts = {}) {
  const env = createGasEnvironment(opts);
  const sandbox = Object.assign({ Buffer: undefined }, env.globals);
  const context = vm.createContext(sandbox);
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).sort();
  for (const file of files) {
    const code = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  // テストから時計を操作できるようにする
  let fakeNow = null;
  context.Clock_.now = () => (fakeNow === null ? Date.now() : fakeNow);
  return Object.assign(env, {
    gas: context,
    setNow: (ms) => { fakeNow = ms; },
    advance: (ms) => { fakeNow = (fakeNow === null ? Date.now() : fakeNow) + ms; }
  });
}

module.exports = { loadGas, SRC_DIR };
