/**
 * 「シートを初期化」の再実行（ステータス「要確認」を入力規則に加えるため）が、
 * 既存の記事・ID・本文・生成履歴・ログを削除・上書き・重複させないことの確認。
 * あわせて、旧仕様で「生成済み」になった文字数不足の記事を安全に扱う手順を確認する。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/load-gas');
const { BASE_PROPS, WP_PROPS, makeArticle, claudeSuccess, httpResponse, wpPost } = require('./helpers/fixtures');

const SHEETS = ['記事管理', '記事本文', 'サンプル記事', '実行ログ'];

function snapshot(spreadsheet) {
  const out = {};
  SHEETS.forEach((name) => {
    const sh = spreadsheet.getSheetByName(name);
    out[name] = JSON.parse(JSON.stringify(sh.data));
  });
  out.sheetNames = spreadsheet.getSheets().map((s) => s.getName());
  return out;
}

/** 生成済み・要確認・未生成が混在し、本文・ログ・サンプルの追記もある状態を作る */
function populated(props, handler) {
  let call = 0;
  const env = loadGas({
    properties: props || BASE_PROPS,
    fetchHandler: handler || (() => claudeSuccess(call++ < 1 ? makeArticle() : makeArticle({ sectionChars: 515 })))
  });
  env.gas.setupSheets_();
  env.gas.addTestKeywords_();
  env.gas.generateArticleForRow_(2); // 生成済み
  env.gas.generateArticleForRow_(3); // 要確認（2回とも短い）
  env.spreadsheet.getSheetByName('サンプル記事').appendRow(['S-2', '自分のサンプル', '本文', true, 'メモ']);
  return env;
}

test('再初期化：記事・ID・本文・生成回数・ログ・サンプルが削除・上書き・重複しない', () => {
  const env = populated();
  assert.equal(env.gas.getArticleRow_(2).status, '生成済み');
  assert.equal(env.gas.getArticleRow_(3).status, '要確認');
  const before = snapshot(env.spreadsheet);

  env.gas.menuSetupSheets();   // メニュー「シートを初期化」
  env.gas.setupSheets_();      // 2回目
  env.gas.menuAddTestKeywords(); // テスト用キーワードの再追加も重複しない

  assert.deepEqual(snapshot(env.spreadsheet), before);
  const ids = env.gas.listArticleRows_().map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'ID の重複なし');
  assert.equal(ids.length, 5);
});

test('再初期化：入力規則は「記事管理」のステータス列（2〜501行目）だけに、要確認を含む一覧で設定される', () => {
  const env = populated();
  const articles = env.spreadsheet.getSheetByName('記事管理');
  articles.validations.length = 0;
  env.gas.menuSetupSheets();
  assert.equal(articles.validations.length, 1);
  const v = articles.validations[0];
  assert.deepEqual([v.row, v.col, v.numRows, v.numCols], [2, env.gas.ARTICLE_COLUMNS.STATUS, 500, 1]);
  assert.ok(v.rule.values.includes('要確認'));
  assert.equal(v.rule.allowInvalid, false);
  // 既存行のステータス値はすべて新しい一覧に含まれる（入力規則の更新で無効値にならない）
  env.gas.listArticleRows_().forEach((a) => assert.ok(v.rule.values.includes(a.status), a.status));
  ['記事本文', 'サンプル記事', '実行ログ'].forEach((n) =>
    assert.equal(env.spreadsheet.getSheetByName(n).validations.length, 0, n));
});

test('旧仕様で「生成済み」になった文字数不足の記事：再初期化しても状態は変わらず、手で「要確認」にすると下書き保存されない', () => {
  const env = populated(WP_PROPS, (url) => {
    if (url.startsWith('https://api.anthropic.com/')) return claudeSuccess(makeArticle({ sectionChars: 515 }));
    throw new Error('WordPress に通信してはいけない');
  });
  // 旧仕様の再現：文字数不足のまま「生成済み」
  env.gas.updateArticleFields_(2, { STATUS: '生成済み' });
  const legacy = env.gas.getArticleRow_(2);
  assert.ok(legacy.charCount < 2000);
  const body = env.gas.getArticleBody_(legacy.id);

  env.gas.menuSetupSheets();
  assert.equal(env.gas.getArticleRow_(2).status, '生成済み', '再初期化では自動で変えない');

  // 人の判断でステータスだけを変更
  env.gas.updateArticleFields_(2, { STATUS: '要確認' });
  const calls = env.state.fetchCalls.length;
  assert.throws(() => env.gas.postDraftForRow_(2), (e) => e.code === 'INVALID_STATE');
  assert.equal(env.state.fetchCalls.length, calls, 'WordPress への通信なし');

  const after = env.gas.getArticleRow_(2);
  assert.equal(after.id, legacy.id);
  assert.equal(after.charCount, legacy.charCount);
  assert.equal(after.title, legacy.title);
  assert.deepEqual(env.gas.getArticleBody_(legacy.id), body, '本文は変わらない');
});

test('旧仕様の記事：確認後に「生成済み」へ戻せば下書き保存できる（人の判断で元に戻せる）', () => {
  const env = populated(WP_PROPS, (url, opt) => {
    if (url.startsWith('https://api.anthropic.com/')) return claudeSuccess(makeArticle({ sectionChars: 515 }));
    return opt.method === 'get' ? httpResponse(200, []) : httpResponse(201, wpPost(88));
  });
  env.gas.updateArticleFields_(2, { STATUS: '要確認' });
  env.gas.updateArticleFields_(2, { STATUS: '生成済み' });
  const res = env.gas.postDraftForRow_(2);
  assert.equal(res.ok, true, res.message);
  assert.equal(env.gas.getArticleRow_(2).status, '下書き保存済み');
});
