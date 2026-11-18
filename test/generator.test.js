'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/load-gas');
const { BASE_PROPS, FAKE_API_KEY, makeArticle, claudeSuccess, claudeError } = require('./helpers/fixtures');

/** シート初期化＋テストキーワード5本を投入した環境 */
function setup(opts = {}) {
  const env = loadGas(Object.assign({ properties: BASE_PROPS }, opts));
  env.gas.setupSheets_();
  env.gas.addTestKeywords_();
  env.sheet = (name) => env.spreadsheet.getSheetByName(name);
  env.row = (n) => env.gas.getArticleRow_(n);
  return env;
}

test('シート初期化：4シート・見出し・ダミーサンプル記事を作成し、再実行しても重複しない', () => {
  const env = setup();
  ['記事管理', '記事本文', 'サンプル記事', '実行ログ'].forEach((n) => assert.ok(env.sheet(n), n));
  assert.equal(env.sheet('記事管理').getCell(1, 4), 'ステータス');
  assert.equal(env.sheet('サンプル記事').getLastRow(), 2);

  env.gas.setupSheets_();
  assert.equal(env.gas.addTestKeywords_(), 0, '2回目は追加しない');
  assert.equal(env.sheet('記事管理').getLastRow(), 6, '見出し＋5行');
  assert.equal(env.sheet('サンプル記事').getLastRow(), 2);
});

test('テスト用キーワード5本にIDと「未生成」が付く', () => {
  const env = setup();
  const rows = env.gas.listArticleRows_();
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.id), ['KW-001', 'KW-002', 'KW-003', 'KW-004', 'KW-005']);
  assert.ok(rows.every((r) => r.status === '未生成'));
});

test('記事生成：タイトル・本文・説明文・処理結果がシートに保存され「生成済み」になる', () => {
  const env = setup({ fetchHandler: () => claudeSuccess(makeArticle()) });
  const res = env.gas.generateArticleForRow_(2);
  assert.equal(res.ok, true, res.message);

  const r = env.row(2);
  assert.equal(r.status, '生成済み');
  assert.equal(r.title, '勤怠管理をエクセルで続ける限界と見直しの4ステップ');
  assert.ok(Array.from(r.metaDescription).length <= 120);
  assert.ok(r.charCount >= 2000 && r.charCount <= 3000);
  assert.match(r.resultMessage, /^OK：/);
  assert.equal(r.generationCount, 1);

  const body = env.gas.getArticleBody_('KW-001');
  assert.ok(body.bodyMarkdown.includes('## まとめ'));
  assert.ok(body.bodyHtml.includes('<h2>'));
  assert.equal(env.sheet('実行ログ').getLastRow(), 2);

  const sent = JSON.parse(env.state.fetchCalls[0].options.payload).messages[0].content;
  assert.ok(sent.includes('<keyword>勤怠管理 エクセル 限界</keyword>'));
  assert.ok(sent.includes('<sample_article>'), 'サンプル記事を文体参考として渡す');
});

test('二重生成防止：生成済みの行は通常の生成では処理せず、APIも呼ばない', () => {
  const env = setup({ fetchHandler: () => claudeSuccess(makeArticle()) });
  env.gas.generateArticleForRow_(2);
  assert.throws(() => env.gas.generateArticleForRow_(2), (e) => e.code === 'INVALID_STATE' && /生成済み/.test(e.message));
  assert.equal(env.state.fetchCalls.length, 1);
});

test('二重生成防止：「生成中」の行は処理しない。10分以上経過した行は再開できる', () => {
  const env = setup({ fetchHandler: () => claudeSuccess(makeArticle()) });
  const t0 = Date.UTC(2026, 10, 16, 1, 0, 0);
  env.setNow(t0);
  env.gas.updateArticleFields_(2, { STATUS: '生成中', STARTED_AT: env.gas.formatDateTime_() });

  env.advance(60 * 1000);
  assert.throws(() => env.gas.generateArticleForRow_(2), (e) => /進行中/.test(e.message));
  assert.equal(env.state.fetchCalls.length, 0);

  env.advance(10 * 60 * 1000);
  assert.equal(env.gas.generateArticleForRow_(2).ok, true);
});

test('ロック取得失敗時は LOCK_TIMEOUT で何もしない', () => {
  const env = setup({ fetchHandler: () => claudeSuccess(makeArticle()) });
  env.state.lockAvailable = false;
  assert.throws(() => env.gas.generateArticleForRow_(2), (e) => e.code === 'LOCK_TIMEOUT');
  assert.equal(env.row(2).status, '未生成');
});

test('再生成：生成済みを上書きでき、生成回数が増える。WordPress投稿済みは拒否', () => {
  const env = setup({ fetchHandler: () => claudeSuccess(makeArticle()) });
  env.gas.generateArticleForRow_(2);
  assert.equal(env.gas.generateArticleForRow_(2, { regenerate: true }).ok, true);
  assert.equal(env.row(2).generationCount, 2);
  assert.equal(env.sheet('記事本文').getLastRow(), 2, '本文は同じIDの行を上書き');

  env.gas.updateArticleFields_(2, { WP_POST_ID: '123' });
  assert.throws(() => env.gas.generateArticleForRow_(2, { regenerate: true }), (e) => /投稿済み/.test(e.message));
});

test('文字数不足の場合は指摘を添えて再生成し、2回目で合格する', () => {
  const env = setup({
    fetchHandler: (u, o, i) => claudeSuccess(makeArticle({ sectionChars: i === 0 ? 300 : 700 }))
  });
  const res = env.gas.generateArticleForRow_(2);
  assert.equal(res.ok, true);
  assert.equal(env.state.fetchCalls.length, 2);
  const retryPrompt = JSON.parse(env.state.fetchCalls[1].options.payload).messages[0].content;
  assert.match(retryPrompt, /前回の出力には次の問題/);
  assert.match(retryPrompt, /短すぎます/);
  assert.match(env.row(2).resultMessage, /試行2回/);
});

test('最大試行回数でも文字数が範囲外なら、記事は保存したうえでステータス「要確認」にする', () => {
  const env = setup({ fetchHandler: () => claudeSuccess(makeArticle({ sectionChars: 1200 })) });
  const res = env.gas.generateArticleForRow_(2);
  assert.equal(res.ok, true);
  assert.equal(env.row(2).status, '要確認');
  assert.equal(res.needsReview, true);
  assert.match(env.row(2).resultMessage, /^要確認：.*長すぎます/);
  assert.ok(env.gas.getArticleBody_(env.row(2).id).bodyHtml, '記事本文は保存されている');
});

test('メタディスクリプションが120文字超のままなら自動で切り詰める', () => {
  const longMeta = 'あ'.repeat(100) + '。' + 'い'.repeat(50);
  const env = setup({ fetchHandler: () => claudeSuccess(makeArticle({ article: { meta_description: longMeta } })) });
  env.gas.generateArticleForRow_(2);
  const r = env.row(2);
  assert.equal(r.metaDescription, 'あ'.repeat(100) + '。');
  assert.match(r.resultMessage, /自動調整/);
});

test('APIエラー時は「生成エラー」と理由を記録し、APIキーは記録しない。再実行で回復できる', () => {
  let fail = true;
  const env = setup({
    fetchHandler: () => (fail ? claudeError(401, 'authentication_error', `bad key ${FAKE_API_KEY}`) : claudeSuccess(makeArticle()))
  });
  const res = env.gas.generateArticleForRow_(2);
  assert.equal(res.ok, false);
  const r = env.row(2);
  assert.equal(r.status, '生成エラー');
  assert.match(r.resultMessage, /AUTH_ERROR/);
  const allCells = JSON.stringify(env.spreadsheet.sheets.map((s) => s.data));
  assert.ok(!allCells.includes(FAKE_API_KEY), 'シートのどこにもAPIキーが残らない');

  fail = false;
  assert.equal(env.gas.generateArticleForRow_(2).ok, true);
});

test('APIキー未設定なら CONFIG_MISSING で、行の状態を変えない', () => {
  const env = setup({ properties: {} });
  assert.throws(() => env.gas.generateArticleForRow_(2), (e) => e.code === 'CONFIG_MISSING');
  assert.equal(env.row(2).status, '未生成');
});

test('一括生成：未生成の行を順に処理する', () => {
  const env = setup({ fetchHandler: () => claudeSuccess(makeArticle()) });
  const rows = env.gas.findPendingRowNumbers_();
  assert.deepEqual(Array.from(rows), [2, 3, 4, 5, 6]);
  const out = env.gas.generateRows_(rows, {});
  assert.equal(out.results.filter((r) => r.ok).length, 5);
  assert.equal(env.gas.findPendingRowNumbers_().length, 0);
});

test('一括生成：実行時間の上限が近づいたら残りを未処理として返す', () => {
  const env = setup({ fetchHandler: () => { env.advance(100 * 1000); return claudeSuccess(makeArticle()); } });
  env.setNow(Date.UTC(2026, 10, 16, 2, 0, 0));
  const out = env.gas.generateRows_([2, 3, 4, 5, 6], {});
  assert.equal(out.results.length, 2);
  assert.deepEqual(Array.from(out.skipped), [4, 5, 6]);
  assert.equal(env.row(4).status, '未生成', '未着手の行は状態を変えない');
});

test('一括生成：認証エラーが出たら残りを中止する', () => {
  const env = setup({ fetchHandler: () => claudeError(401, 'authentication_error', 'invalid') });
  const out = env.gas.generateRows_([2, 3, 4], {});
  assert.equal(out.results.length, 1);
  assert.deepEqual(Array.from(out.skipped), [3, 4]);
  assert.equal(env.state.fetchCalls.length, 1);
});

test('停止した処理のリセット：10分以上経過した「生成中」を「生成エラー」に戻す', () => {
  const env = setup();
  env.setNow(Date.UTC(2026, 10, 16, 3, 0, 0));
  env.gas.updateArticleFields_(2, { STATUS: '生成中', STARTED_AT: env.gas.formatDateTime_() });
  env.gas.updateArticleFields_(3, { STATUS: '投稿中', STARTED_AT: env.gas.formatDateTime_() });
  assert.equal(env.gas.resetStuckRows_(false), 0);
  env.advance(11 * 60 * 1000);
  assert.equal(env.gas.resetStuckRows_(false), 2);
  assert.equal(env.row(2).status, '生成エラー');
  assert.equal(env.row(3).status, '投稿エラー');
});
