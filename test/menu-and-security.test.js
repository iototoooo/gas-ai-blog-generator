'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas, SRC_DIR } = require('./helpers/load-gas');
const { BASE_PROPS, WP_PROPS, FAKE_API_KEY, makeArticle, claudeSuccess, httpResponse, wpPost } = require('./helpers/fixtures');

const ROOT = path.join(__dirname, '..');

test('onOpen：「記事生成」メニューと各項目が登録され、関数が実在する', () => {
  const { gas, state } = loadGas();
  gas.onOpen();
  assert.equal(state.menus.length, 1);
  const menu = state.menus[0];
  assert.equal(menu.title, '記事生成');
  const fns = [];
  const walk = (m) => m.items.forEach((it) => { if (it.fn) fns.push(it.fn); if (it.submenu) walk(it.submenu); });
  walk(menu);
  ['menuGenerateSelected', 'menuGeneratePending', 'menuRegenerateSelected', 'menuPostSelected',
    'menuSetupSheets', 'menuAddTestKeywords', 'menuShowSettingsStatus', 'menuResetStuck']
    .forEach((f) => assert.ok(fns.includes(f), f));
  fns.forEach((f) => assert.equal(typeof gas[f], 'function', `${f} が定義されていない`));
});

test('メニュー操作：選択行の生成 → 下書き保存 を一連で実行できる', () => {
  const env = loadGas({ properties: WP_PROPS });
  env.setFetchHandler((url, opt) => {
    if (url.startsWith('https://api.anthropic.com/')) return claudeSuccess(makeArticle());
    return opt.method === 'get' ? httpResponse(200, []) : httpResponse(201, wpPost(55));
  });
  env.gas.menuSetupSheets();
  env.gas.menuAddTestKeywords();
  const sheet = env.spreadsheet.getSheetByName('記事管理');
  sheet.select(2, 2); // 2〜3行目を選択
  env.gas.menuGenerateSelected();
  assert.match(env.state.alerts.at(-1), /KW-001：✅/);
  assert.match(env.state.alerts.at(-1), /KW-002：✅/);

  sheet.select(2);
  env.gas.menuPostSelected();
  assert.match(env.state.alerts.at(-1), /2行目：✅ WordPressに下書き保存しました/);
  assert.equal(env.gas.getArticleRow_(2).status, '下書き保存済み');
});

test('メニュー操作：記事管理シート以外で実行するとエラー表示（例外で止まらない）', () => {
  const env = loadGas({ properties: BASE_PROPS });
  env.gas.setupSheets_();
  env.spreadsheet.getSheetByName('記事本文').select(2);
  env.gas.menuGenerateSelected();
  assert.match(env.state.alerts.at(-1), /「記事管理」シートで/);
});

test('メニュー操作：再生成は確認ダイアログで「いいえ」なら何もしない', () => {
  const env = loadGas({ properties: BASE_PROPS, fetchHandler: () => claudeSuccess(makeArticle()) });
  env.gas.setupSheets_();
  env.gas.addTestKeywords_();
  env.gas.generateArticleForRow_(2);
  env.spreadsheet.getSheetByName('記事管理').select(2);
  env.state.nextAlertResponses.push('NO');
  env.gas.menuRegenerateSelected();
  assert.equal(env.state.fetchCalls.length, 1);
});

test('設定状況の表示：秘密情報の値を表示しない', () => {
  const env = loadGas({ properties: WP_PROPS });
  env.gas.menuShowSettingsStatus();
  const msg = env.state.alerts.at(-1);
  assert.match(msg, /CLAUDE_API_KEY：設定済み/);
  assert.ok(!msg.includes(FAKE_API_KEY));
  assert.ok(!msg.includes(WP_PROPS.WP_APP_PASSWORD));
});

test('セキュリティ：ソースコードにAPIキー・パスワードらしき値が書かれていない', () => {
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const code = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    assert.ok(!/sk-ant-[A-Za-z0-9]{8,}/.test(code), `${f} にAPIキーらしき文字列`);
    // Script Properties のキー名定義（例: CLAUDE_API_KEY: 'CLAUDE_API_KEY'）は除外し、実際の値らしきものだけを検出する
    const suspicious = [...code.matchAll(/(api[_-]?key|password)\s*[:=]\s*['"]([^'"]{6,})['"]/gi)]
      .filter((m) => !/^[A-Z_]+$/.test(m[2]));
    assert.deepEqual(suspicious.map((m) => m[0]), [], `${f} に認証情報らしき代入`);
  }
});

test('セキュリティ：投稿ステータスに publish を送るコードが存在しない', () => {
  const code = fs.readFileSync(path.join(SRC_DIR, 'WordPressClient.js'), 'utf8');
  assert.ok(!/status\s*:\s*['"]publish['"]/.test(code));
  assert.match(code, /var WP_DRAFT_STATUS = 'draft';/);
});

test('セキュリティ：.gitignore が秘密情報・clasp設定を除外している', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  ['.clasp.json', '.clasprc.json', '.env', 'node_modules'].forEach((p) => assert.ok(gi.includes(p), p));
});

test('samples/test-keywords.csv とコード内のテスト用キーワード5本が一致する', () => {
  const { gas } = loadGas();
  const csv = fs.readFileSync(path.join(ROOT, 'samples', 'test-keywords.csv'), 'utf8').trim().split(/\r?\n/).slice(1);
  const fromCsv = csv.map((line) => line.split(',')[0]);
  assert.equal(fromCsv.length, 5);
  assert.deepEqual(fromCsv, Array.from(gas.TEST_KEYWORDS, (k) => k.keyword));
});

test('教材サンプル記事の非公開：.gitignore で除外し、同梱のサンプル記事はダミーであることを明示', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  ['samples/private/', 'samples/*教材*'].forEach((p) => assert.ok(gi.includes(p), p));
  const sample = fs.readFileSync(path.join(ROOT, 'samples', 'sample-article.md'), 'utf8');
  assert.match(sample, /動作確認用ダミー/);
  assert.match(sample, /【ダミー】/);
  const { gas } = loadGas();
  assert.match(gas.DUMMY_SAMPLE_ARTICLE.title, /^【ダミー】/);
});
