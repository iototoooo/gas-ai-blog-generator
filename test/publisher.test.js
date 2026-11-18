'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/load-gas');
const {
  BASE_PROPS, WP_PROPS, FAKE_WP_PASSWORD, makeArticle, claudeSuccess, wpPost, httpResponse
} = require('./helpers/fixtures');

/**
 * Claude と WordPress の両方をモックする。
 * wp: { search: () => [], create: () => httpResponse }
 */
function setup(props, wp = {}) {
  const env = loadGas({ properties: props });
  env.wpCalls = [];
  env.setFetchHandler((url, options) => {
    if (url.startsWith('https://api.anthropic.com/')) return claudeSuccess(makeArticle());
    env.wpCalls.push({ url, method: options.method, payload: options.payload ? JSON.parse(options.payload) : null, headers: options.headers });
    if (options.method === 'get') return wp.search ? wp.search() : httpResponse(200, []);
    return wp.create ? wp.create() : httpResponse(201, wpPost(101));
  });
  env.gas.setupSheets_();
  env.gas.addTestKeywords_();
  env.gas.generateArticleForRow_(2);
  env.row = (n) => env.gas.getArticleRow_(n);
  return env;
}

test('WordPress未設定：エラーにせずスキップし、「生成済み」のまま利用できる', () => {
  const env = setup(BASE_PROPS);
  const res = env.gas.postDraftForRow_(2);
  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
  assert.equal(env.row(2).status, '生成済み');
  assert.equal(env.wpCalls.length, 0);
});

test('下書き投稿：status=draft で送信し、投稿IDと編集URLを保存して「下書き保存済み」にする', () => {
  const env = setup(WP_PROPS);
  const res = env.gas.postDraftForRow_(2);
  assert.equal(res.ok, true, res.message);

  const create = env.wpCalls.find((c) => c.method === 'post');
  assert.equal(create.url, 'https://blog.example.com/wp-json/wp/v2/posts');
  assert.equal(create.payload.status, 'draft');
  assert.equal(create.payload.slug, 'aiblog-kw-001');
  assert.equal(create.payload.title, '勤怠管理をエクセルで続ける限界と見直しの4ステップ');
  assert.ok(create.payload.content.includes('<h2>'));
  assert.ok(Array.from(create.payload.excerpt).length <= 120);
  const expectedAuth = 'Basic ' + Buffer.from('editor:' + FAKE_WP_PASSWORD).toString('base64');
  assert.equal(create.headers.Authorization, expectedAuth);

  const r = env.row(2);
  assert.equal(r.status, '下書き保存済み');
  assert.equal(r.wpPostId, '101');
  assert.equal(r.wpUrl, 'https://blog.example.com/wp-admin/post.php?post=101&action=edit');
});

test('二重投稿防止：下書き保存済みの行は再投稿しない', () => {
  const env = setup(WP_PROPS);
  env.gas.postDraftForRow_(2);
  const before = env.wpCalls.length;
  assert.throws(() => env.gas.postDraftForRow_(2), (e) => e.code === 'INVALID_STATE');
  assert.equal(env.wpCalls.length, before);
});

test('二重投稿防止：同じスラッグの投稿が既にあれば、新規作成せず紐付ける', () => {
  const env = setup(WP_PROPS, { search: () => httpResponse(200, [wpPost(77)]) });
  const res = env.gas.postDraftForRow_(2);
  assert.equal(res.ok, true);
  assert.match(res.message, /紐付け/);
  assert.equal(env.wpCalls.filter((c) => c.method === 'post').length, 0);
  assert.equal(env.row(2).wpPostId, '77');
});

test('投稿作成の 5xx は自動再送しない（二重投稿防止）。「投稿エラー」から再実行で回復できる', () => {
  let fail = true;
  const env = setup(WP_PROPS, {
    create: () => (fail ? httpResponse(502, 'Bad Gateway') : httpResponse(201, wpPost(102)))
  });
  const res = env.gas.postDraftForRow_(2);
  assert.equal(res.ok, false);
  assert.equal(env.wpCalls.filter((c) => c.method === 'post').length, 1, '再送しない');
  assert.equal(env.row(2).status, '投稿エラー');
  assert.equal(env.row(2).wpPostId, '');

  fail = false;
  assert.equal(env.gas.postDraftForRow_(2).ok, true);
  assert.equal(env.row(2).wpPostId, '102');
});

test('WordPress認証エラー：「投稿エラー」にし、パスワードを記録しない', () => {
  const env = setup(WP_PROPS, {
    search: () => httpResponse(401, { code: 'rest_not_logged_in', message: 'ログインしていません' })
  });
  const res = env.gas.postDraftForRow_(2);
  assert.equal(res.code, 'AUTH_ERROR');
  assert.equal(env.row(2).status, '投稿エラー');
  const allCells = JSON.stringify(env.spreadsheet.sheets.map((s) => s.data));
  assert.ok(!allCells.includes(FAKE_WP_PASSWORD));
});

test('未生成の行は投稿できない', () => {
  const env = setup(WP_PROPS);
  assert.throws(() => env.gas.postDraftForRow_(3), (e) => /生成されていません/.test(e.message));
});

test('WP_BASE_URL が http:// の場合は送信しない', () => {
  const env = setup(Object.assign({}, WP_PROPS, { WP_BASE_URL: 'http://blog.example.com' }));
  const res = env.gas.postDraftForRow_(2);
  assert.equal(res.ok, false);
  assert.match(res.message, /https/);
  assert.equal(env.wpCalls.length, 0);
});

test('WordPressが draft 以外を返した場合は注意を表示する', () => {
  const env = setup(WP_PROPS, { create: () => httpResponse(201, wpPost(103, 'publish')) });
  const res = env.gas.postDraftForRow_(2);
  assert.match(res.message, /注意/);
});
