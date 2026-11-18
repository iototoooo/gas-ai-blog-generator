/**
 * clasp push 前の配置チェック。Google には接続しない。
 * GAS では全ファイルが1つのグローバル空間を共有し、読み込み順は保証されないため、
 * 「どの順番で読み込んでも動く」「名前が衝突しない」「公開関数が正しい」ことを確認する。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { createGasEnvironment } = require('./helpers/gas-mock');
const { SRC_DIR } = require('./helpers/load-gas');
const { extractScriptId, maskId, buildClaspConfig, setupClasp } = require('../scripts/setup-clasp');

const ROOT = path.join(__dirname, '..');
const JS_FILES = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).sort();
const EXPECTED_FILES = [
  'ArticleFormatter.js', 'ClaudeClient.js', 'Config.js', 'Generator.js', 'HttpClient.js', 'Menu.js',
  'PromptBuilder.js', 'Publisher.js', 'Setup.js', 'SheetRepository.js', 'Utils.js', 'WordPressClient.js'
];
/** スプレッドシートのメニューやエディタから実行できる公開関数（末尾 _ なし） */
const PUBLIC_FUNCTIONS = [
  'onOpen', 'menuGenerateSelected', 'menuGeneratePending', 'menuRegenerateSelected', 'menuPostSelected',
  'menuOpenBody', 'menuResetStuck', 'menuSetupSheets', 'menuAddTestKeywords', 'menuShowSettingsStatus',
  'menuTestWordPress'
];
const DUMMY_ID = 'DUMMY_SCRIPT_ID_FOR_LOCAL_CHECK_ONLY_0000000000000000000';

function newContext() {
  return vm.createContext(Object.assign({}, createGasEnvironment().globals));
}
function loadInOrder(files) {
  const ctx = newContext();
  files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'), ctx, { filename: f }));
  return ctx;
}
function topLevelNames(file) {
  const before = new Set(Object.keys(newContext()));
  const ctx = newContext();
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, file), 'utf8'), ctx, { filename: file });
  return Object.keys(ctx).filter((k) => !before.has(k));
}

test('配置：src/ は .js 12ファイル＋appsscript.json のみ（サブフォルダ・.gs・初期コード Code なし）', () => {
  const entries = fs.readdirSync(SRC_DIR, { withFileTypes: true });
  assert.deepEqual(entries.filter((e) => e.isDirectory()).map((e) => e.name), []);
  assert.deepEqual(JS_FILES, EXPECTED_FILES.slice().sort());
  assert.deepEqual(entries.map((e) => e.name).filter((n) => !n.endsWith('.js')), ['appsscript.json']);
  assert.ok(!fs.existsSync(path.join(SRC_DIR, 'Code.js')) && !fs.existsSync(path.join(SRC_DIR, 'Code.gs')));
});

test('GAS互換：require / module.exports / import / export を使っていない', () => {
  JS_FILES.forEach((f) => {
    const code = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    assert.doesNotMatch(code, /\brequire\(|module\.exports|^\s*(import|export)\s/m, f);
  });
});

test('読み込み順：各ファイルを単独で読み込んでもエラーにならない（ファイル間の初期化順に依存しない）', () => {
  JS_FILES.forEach((f) => assert.doesNotThrow(() => loadInOrder([f]), f));
});

test('読み込み順：昇順・降順・clasp の送信順のどれでも onOpen とシート初期化が動く', () => {
  const orders = [
    JS_FILES,
    JS_FILES.slice().reverse(),
    ['ClaudeClient.js', 'Config.js', 'PromptBuilder.js', 'ArticleFormatter.js', 'Generator.js', 'HttpClient.js',
      'Publisher.js', 'Menu.js', 'SheetRepository.js', 'Setup.js', 'WordPressClient.js', 'Utils.js']
  ];
  orders.forEach((order) => {
    const ctx = loadInOrder(order);
    assert.doesNotThrow(() => ctx.onOpen(), order.join(','));
    assert.doesNotThrow(() => ctx.setupSheets_(), order.join(','));
  });
});

test('名前の衝突：ファイルをまたいで同じ関数名・変数名を定義していない（GASでは後勝ちで黙って上書きされる）', () => {
  const owner = {};
  JS_FILES.forEach((f) => topLevelNames(f).forEach((name) => {
    assert.ok(!owner[name], `${name} が ${owner[name]} と ${f} の両方で定義されている`);
    owner[name] = f;
  }));
  assert.ok(!owner.myFunction, '初期コードの myFunction が残っている');
});

test('公開関数：末尾 _ なしのグローバル関数はメニュー用の11個だけ。メニューから呼ぶ関数はすべて公開関数', () => {
  const ctx = loadInOrder(JS_FILES);
  const publicFns = JS_FILES.flatMap(topLevelNames)
    .filter((n) => typeof ctx[n] === 'function' && !n.endsWith('_'));
  assert.deepEqual(publicFns.slice().sort(), PUBLIC_FUNCTIONS.slice().sort());

  const env = createGasEnvironment();
  const ctx2 = vm.createContext(Object.assign({}, env.globals));
  JS_FILES.forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'), ctx2, { filename: f }));
  ctx2.onOpen();
  const fns = [];
  const walk = (m) => m.items.forEach((it) => { if (it.fn) fns.push(it.fn); if (it.submenu) walk(it.submenu); });
  walk(env.state.menus[0]);
  assert.deepEqual(fns.slice().sort(), PUBLIC_FUNCTIONS.filter((n) => n !== 'onOpen').sort());
});

test('マニフェスト：V8・Asia/Tokyo・必要最小限の3スコープ。広い権限が要る API を使っていない', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'appsscript.json'), 'utf8'));
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.timeZone, 'Asia/Tokyo');
  assert.deepEqual(manifest.oauthScopes.slice().sort(), [
    'https://www.googleapis.com/auth/script.container.ui',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/spreadsheets.currentonly'
  ]);
  const all = JS_FILES.map((f) => fs.readFileSync(path.join(SRC_DIR, f), 'utf8')).join('\n');
  // currentonly スコープでは別ファイルを開けない。Drive・メール等は権限を宣言していない
  assert.doesNotMatch(all, /\b(DriveApp|MailApp|GmailApp|CalendarApp|DocumentApp|ScriptApp)\b|openById|openByUrl|SpreadsheetApp\.create/);
  assert.match(all, /UrlFetchApp\.fetch/);   // external_request
  assert.match(all, /getUi\(\)/);            // container.ui
});

test('clasp 設定：.clasp.json は Git 管理外、例ファイルは rootDir=src でIDを含まない', () => {
  const ignored = (file) => {
    try { execFileSync('git', ['check-ignore', '-q', file], { cwd: ROOT, stdio: 'ignore' }); return true; } catch (e) { return false; }
  };
  assert.ok(ignored('.clasp.json'));
  assert.ok(ignored('.clasprc.json'));
  assert.ok(!ignored('.clasp.json.example'));
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, '.clasp.json.example'), 'utf8'));
  assert.equal(example.rootDir, 'src');
  assert.doesNotMatch(example.scriptId, /^[A-Za-z0-9_-]{30,}$/);
});

test('setup-clasp：スクリプトID・エディタURLを受け付け、スプレッドシートURLや不正値は拒否する', () => {
  assert.equal(extractScriptId('  ' + DUMMY_ID + '\r\n'), DUMMY_ID);
  assert.equal(extractScriptId('https://script.google.com/home/projects/' + DUMMY_ID + '/edit'), DUMMY_ID);
  assert.equal(extractScriptId('https://script.google.com/d/' + DUMMY_ID + '/edit'), DUMMY_ID);
  assert.throws(() => extractScriptId('https://docs.google.com/spreadsheets/d/' + DUMMY_ID + '/edit'), /スクリプトID/);
  assert.throws(() => extractScriptId(''), /形式/);
  assert.throws(() => extractScriptId('abc def'), /形式/);
  assert.equal(maskId(DUMMY_ID).includes(DUMMY_ID), false);
  assert.deepEqual(buildClaspConfig(DUMMY_ID), { scriptId: DUMMY_ID, rootDir: 'src' });
});

test('setup-clasp：既存の .clasp.json は --force なしでは上書きしない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clasp-setup-'));
  try {
    setupClasp({ root: dir, input: DUMMY_ID, skipGitCheck: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.clasp.json'), 'utf8')), { scriptId: DUMMY_ID, rootDir: 'src' });
    assert.throws(() => setupClasp({ root: dir, input: DUMMY_ID, skipGitCheck: true }), /--force/);
    assert.doesNotThrow(() => setupClasp({ root: dir, input: DUMMY_ID, skipGitCheck: true, force: true }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CLASP_BIN = path.join(ROOT, 'node_modules', '@google', 'clasp', 'build', 'src', 'index.js');
test('clasp 送信対象：.claspignore により src/ の13ファイルだけが対象になる（ダミーIDで確認・通信なし）',
  { skip: !fs.existsSync(CLASP_BIN) && 'clasp 未インストール（npm install で導入）' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clasp-status-'));
    try {
      fs.cpSync(SRC_DIR, path.join(dir, 'src'), { recursive: true });
      fs.copyFileSync(path.join(ROOT, '.claspignore'), path.join(dir, '.claspignore'));
      fs.writeFileSync(path.join(dir, 'src', 'memo.md'), 'x');
      fs.writeFileSync(path.join(dir, '.clasp.json'), JSON.stringify({ scriptId: DUMMY_ID, rootDir: 'src' }));
      const out = execFileSync(process.execPath, [CLASP_BIN, 'show-file-status', '--json'], { cwd: dir, encoding: 'utf8' });
      const status = JSON.parse(out);
      const pushed = status.filesToPush.map((p) => path.basename(p)).sort();
      assert.deepEqual(pushed, EXPECTED_FILES.concat('appsscript.json').sort());
      assert.deepEqual(status.untrackedFiles.map((p) => path.basename(p)), ['memo.md']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
