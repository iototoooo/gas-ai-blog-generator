/**
 * 実環境テスト「有給休暇 管理 方法」（1,995文字・API 2回・生成済み）を受けた修正のテスト。
 * - 必須条件を満たさない記事はステータス「要確認」にし、WordPress へ保存させない
 * - 書き直しでは、必須条件に最も近い記事を残す
 * - 計算式の説明だけで「仮の数値」の誤警告を出さない
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('./helpers/load-gas');
const { BASE_PROPS, WP_PROPS, makeArticle, claudeSuccess, httpResponse, wpPost } = require('./helpers/fixtures');

function setup(props, handler) {
  const env = loadGas({ properties: props || BASE_PROPS, fetchHandler: handler });
  env.gas.setupSheets_();
  env.gas.addTestKeywords_();
  env.row = (n) => env.gas.getArticleRow_(n);
  return env;
}
/** 文字数が 2,000 をわずかに下回る記事（本文 1,996文字。実環境の 1,995 文字に相当） */
function slightlyShort() {
  return makeArticle({ sectionChars: 515 });
}
function chars(gas, article) {
  return gas.validateArticle_(gas.normalizeArticle_(article), '勤怠管理', '', '').charCount;
}
function errorOf(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

test('前提：テスト用の記事は 2,000 文字をわずかに下回る', () => {
  const { gas } = setup();
  const n = chars(gas, slightlyShort());
  assert.ok(n >= 1950 && n < 2000, String(n));
});

test('再現：書き直し後も2,000文字未満なら、ステータスは「生成済み」ではなく「要確認」（API 2回、記事は保存）', () => {
  const env = setup(BASE_PROPS, () => claudeSuccess(slightlyShort()));
  const res = env.gas.generateArticleForRow_(2);
  assert.equal(res.ok, true);
  assert.equal(res.needsReview, true);
  assert.equal(env.state.fetchCalls.length, 2);
  const r = env.row(2);
  assert.equal(r.status, '要確認');
  assert.match(r.resultMessage, /^要確認：本文が\d+文字で短すぎます/);
  assert.ok(env.gas.getArticleBody_(r.id).bodyHtml, '課金済みの記事は捨てずに保存');
  const log = env.spreadsheet.getSheetByName('実行ログ');
  assert.equal(log.getCell(log.getLastRow(), 4), '要確認');
});

test('要確認の記事：WordPress への下書き保存はできず、確認方法を案内する', () => {
  const env = setup(WP_PROPS, (url) => {
    if (url.startsWith('https://api.anthropic.com/')) return claudeSuccess(slightlyShort());
    throw new Error('WordPress に通信してはいけない');
  });
  env.gas.generateArticleForRow_(2);
  const before = env.state.fetchCalls.length;
  const e = errorOf(() => env.gas.postDraftForRow_(2));
  assert.equal(e && e.code, 'INVALID_STATE');
  assert.match(e.message, /要確認.*「生成済み」に変更してから下書き保存/);
  assert.equal(env.state.fetchCalls.length, before, 'WordPress への通信なし');
  assert.equal(env.row(2).status, '要確認', 'ステータスは変わらない');
});

test('要確認の記事：人が確認してステータスを「生成済み」に戻せば、下書き保存できる', () => {
  const env = setup(WP_PROPS, (url, opt) => {
    if (url.startsWith('https://api.anthropic.com/')) return claudeSuccess(slightlyShort());
    return opt.method === 'get' ? httpResponse(200, []) : httpResponse(201, wpPost(77));
  });
  env.gas.generateArticleForRow_(2);
  env.gas.updateArticleFields_(2, { STATUS: '生成済み' });
  const res = env.gas.postDraftForRow_(2);
  assert.equal(res.ok, true, res.message);
  assert.equal(env.row(2).status, '下書き保存済み');
});

test('要確認の記事：通常の「生成」では上書きせず、「再生成（上書き）」でのみ作り直せる', () => {
  const env = setup(BASE_PROPS, () => claudeSuccess(slightlyShort()));
  env.gas.generateArticleForRow_(2);
  const calls = env.state.fetchCalls.length;
  const e = errorOf(() => env.gas.generateArticleForRow_(2));
  assert.equal(e && e.code, 'INVALID_STATE');
  assert.match(e.message, /再生成（上書き）/);
  assert.equal(env.state.fetchCalls.length, calls, 'API を呼ばない');

  env.setFetchHandler(() => claudeSuccess(makeArticle()));
  const res = env.gas.generateArticleForRow_(2, { regenerate: true });
  assert.equal(res.ok, true);
  assert.equal(env.row(2).status, '生成済み');
});

test('一括生成：「要確認」の行は対象外（未生成のみ）', () => {
  const env = setup(BASE_PROPS, () => claudeSuccess(slightlyShort()));
  env.gas.generateArticleForRow_(2);
  assert.ok(!env.gas.findPendingRowNumbers_().includes(2));
});

test('ステータス一覧と入力規則：「要確認」を含む（「シートを初期化」の再実行で既存シートの入力規則も更新される）', () => {
  const { gas } = setup();
  assert.ok(gas.STATUS_LIST.includes('要確認'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Setup.js'), 'utf8');
  assert.match(src, /var articles = ensureSheet_\([^)]*\);\n\s*applyStatusValidation_\(articles\);/, '既存シートでも毎回適用');
});

test('書き直し：後の試行の方が悪ければ、必須条件に近い前の記事を残す', () => {
  const env = setup(BASE_PROPS, (url, opt, i) => claudeSuccess(i === 0 ? slightlyShort() : makeArticle({ sectionChars: 300 })));
  env.gas.generateArticleForRow_(2);
  const r = env.row(2);
  assert.equal(env.state.fetchCalls.length, 2);
  assert.equal(r.charCount, chars(env.gas, slightlyShort()), '1回目（不足が小さい方）を保存');
  assert.match(r.resultMessage, /要確認/);
});

test('書き直し：2回目で条件を満たせば2回目を採用し「生成済み」', () => {
  const env = setup(BASE_PROPS, (url, opt, i) => claudeSuccess(i === 0 ? slightlyShort() : makeArticle()));
  env.gas.generateArticleForRow_(2);
  const r = env.row(2);
  assert.equal(r.status, '生成済み');
  assert.match(r.resultMessage, /^OK：.*試行2回/);
});

test('書き直しの指示：不足文字数の目安と、空白・改行を除いて数えることを伝える', () => {
  const env = setup(BASE_PROPS, () => claudeSuccess(slightlyShort()));
  env.gas.generateArticleForRow_(2);
  const retry = JSON.parse(env.state.fetchCalls[1].options.payload).messages[0].content;
  const n = chars(env.gas, slightlyShort());
  assert.ok(retry.includes('約' + (2500 - n) + '文字'), retry);
  assert.match(retry, /空白・改行を除いて数えています/);
  assert.match(retry, /各H2の本文/);
});

// ---- 仮の数値チェックの誤警告 ----

test('仮の数値：計算式の説明だけ（単位つきの数値なし）では警告しない', () => {
  const { gas } = setup();
  [
    '取得率は、一般的に「取得日数の合計÷付与日数の合計×100」で計算します。',
    '取得率の計算例として、分母と分子に何を含めるかを社内で決めておきましょう。',
    'たとえば、部署ごとに取得状況を一覧にすると偏りに気づきやすくなります。',
    '時間単位の休暇をどう数えるかは、就業規則や労使協定で確認してください。'
  ].forEach((t) => assert.equal(gas.hasUnlabeledEstimate_(t), false, t));
});

test('仮の数値：単位つきの数値を使った例に注記がなければ警告し、注記があれば警告しない', () => {
  const { gas } = setup();
  const example = 'たとえば付与日数が10日で5日取得した場合、取得率は50%になります。';
  assert.equal(gas.hasUnlabeledEstimate_(example), true);
  assert.equal(gas.hasUnlabeledEstimate_('従業員30人で計算すると、月に300分の作業になります。'), true);
  assert.equal(gas.hasUnlabeledEstimate_('※以下は説明のための仮の数値です。実際の数値は職場によって異なります。\n' + example), false);
  assert.equal(gas.hasUnlabeledEstimate_('年5日の取得が必要とされる場合があります。'), false, '試算の文脈でなければ対象外');
});

// ---- プロンプト（v2 のみ。v1 は変更しない） ----

test('v2：制度の対象者・数え方・例外と、取得率などの計算式を断定しないよう指示している', () => {
  const { gas } = setup();
  const p = gas.buildSystemPrompt_({ promptVersion: 'v2' });
  assert.match(p, /対象者・数え方・例外/);
  assert.match(p, /時間単位や半日単位の休暇をどう数えるか/);
  assert.match(p, /就業規則や労使協定、公的な解説資料で確認/);
  assert.match(p, /「一般的な考え方の一例」として示し、分母・分子に何を含めるかは調査や社内の定義によって異なる/);
  const v1 = fs.readFileSync(path.join(__dirname, 'fixtures', 'prompt-v1-system.txt'), 'utf8');
  assert.equal(gas.buildSystemPrompt_({ promptVersion: 'v1' }), v1);
});
