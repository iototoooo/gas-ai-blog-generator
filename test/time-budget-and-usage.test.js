'use strict';
/**
 * GAS 実行時間制限（6分）に対する上限確認と、API使用量・推定費用の記録のテスト。
 * 時計はモックで進めるため、実時間は待たない。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/load-gas');
const { BASE_PROPS, makeArticle, claudeSuccess, claudeError, httpResponse } = require('./helpers/fixtures');

const GAS_LIMIT_MS = 360 * 1000;
const T0 = Date.UTC(2026, 10, 16, 5, 0, 0);

/**
 * 1回の API 呼び出しに latencyMs かかる環境を作る。Utilities.sleep も時計を進める。
 * respond(callIndex) で応答を決める。
 */
function timedEnv(latencyMs, respond, props = BASE_PROPS) {
  const env = loadGas({ properties: props });
  env.setNow(T0);
  env.globals.Utilities.sleep = (ms) => { env.state.sleeps.push(ms); env.advance(ms); };
  env.gas.setupSheets_();
  env.gas.addTestKeywords_();
  env.setFetchHandler((url, opt, i) => {
    env.advance(latencyMs);
    return respond(i);
  });
  env.elapsed = () => env.gas.Clock_.now() - T0;
  return env;
}

const SCENARIOS = {
  '常に529（過負荷）': () => claudeError(529, 'overloaded_error', 'Overloaded'),
  '常に429（Retry-After 30秒）': () => claudeError(429, 'rate_limit_error', 'limit', { 'retry-after': '30' }),
  '常に通信例外': () => { throw new Error('Timeout: https://api.anthropic.com'); },
  '常に文字数不足（書き直しが続く）': () => claudeSuccess(makeArticle({ sectionChars: 300 })),
  '1回目不足→2回目合格': (i) => claudeSuccess(makeArticle({ sectionChars: i % 2 === 0 ? 300 : 700 })),
  '常に正常': () => claudeSuccess(makeArticle())
};

for (const latencySec of [5, 30, 60, 90, 120]) {
  for (const [name, respond] of Object.entries(SCENARIOS)) {
    test(`実行時間の上限：応答${latencySec}秒×「${name}」で5件一括処理しても6分を超えず、1記事のAPI呼び出しは4回以内`, () => {
      const env = timedEnv(latencySec * 1000, respond);
      const out = env.gas.generateRows_([2, 3, 4, 5, 6], {});

      assert.ok(env.elapsed() <= GAS_LIMIT_MS - 15 * 1000,
        `経過 ${Math.round(env.elapsed() / 1000)} 秒（GAS上限360秒に対し15秒以上の余裕が必要）`);
      out.results.forEach((r) => {
        if (r.usage) assert.ok(r.usage.calls <= 4, `${r.id} のAPI呼び出し ${r.usage.calls} 回`);
      });
      assert.equal(out.results.length + out.skipped.length, 5, '全行が「処理済み」か「未処理」に分類される');
      // 中途半端な「生成中」が残らない
      assert.ok(env.gas.listArticleRows_().every((a) => a.status !== '生成中'));
    });
  }
}

test('使用量の記録：書き直しを含む合計トークン・呼び出し回数・推定費用を記事本文シートに保存', () => {
  const env = timedEnv(1000, (i) => claudeSuccess(makeArticle({ sectionChars: i === 0 ? 300 : 700 })));
  const res = env.gas.generateArticleForRow_(2);
  assert.equal(res.ok, true);

  const body = env.spreadsheet.getSheetByName('記事本文');
  const headers = body.getRange(1, 1, 1, 12).getValues()[0];
  const row = body.getRange(2, 1, 1, 12).getValues()[0];
  const get = (h) => row[headers.indexOf(h)];
  assert.equal(get('モデル'), 'claude-opus-5-5', '応答の model（フィクスチャ値）を記録');
  assert.equal(get('入力トークン'), 2400, '1,200×2回');
  assert.equal(get('出力トークン'), 6800, '3,400×2回');
  assert.equal(get('API呼び出し回数'), 2);
  // Opus 5.5 単価（$4 / $20）で 2,400×4 + 6,800×20 = 145,600 / 1e6
  assert.equal(get('推定費用（USD）'), 0.1456);

  const log = env.spreadsheet.getSheetByName('実行ログ');
  assert.match(log.getCell(2, 5), /API呼び出し 2回 \/ 入力 2400 \/ 出力 6800トークン \/ 推定 \$0\.1456/);
});

test('使用量の記録：Haiku 5.5 の応答なら Haiku 単価で計算', () => {
  const env = timedEnv(1000, () => claudeSuccess(makeArticle(), { model: 'claude-haiku-5-5' }));
  env.gas.generateArticleForRow_(2);
  const row = env.spreadsheet.getSheetByName('記事本文').getRange(2, 1, 1, 12).getValues()[0];
  assert.equal(row[7], 'claude-haiku-5-5');
  // 1,200×0.10 + 3,400×0.50 = 1,820 / 1e6
  assert.equal(row[11], 0.00182);
});

test('使用量の記録：応答拒否（HTTP 200・課金あり）で失敗した場合も実行ログにトークン数を残す', () => {
  const env = timedEnv(1000, () => claudeSuccess(makeArticle(), {
    model: 'claude-haiku-5-5', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms' }
  }));
  const res = env.gas.generateArticleForRow_(2);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'REFUSAL');
  const detail = env.spreadsheet.getSheetByName('実行ログ').getCell(2, 5);
  assert.match(detail, /REFUSAL/);
  assert.match(detail, /API呼び出し 1回 \/ 入力 1200 \/ 出力 3400トークン/);
});

test('書き直しのAPIが失敗しても、1回目の記事（課金済み）を保存し、文字数不足ならステータス「要確認」にする', () => {
  const env = timedEnv(1000, (i) => (i === 0
    ? claudeSuccess(makeArticle({ sectionChars: 300 }))
    : claudeError(529, 'overloaded_error', 'Overloaded')));
  const res = env.gas.generateArticleForRow_(2);
  assert.equal(res.ok, true);
  const r = env.gas.getArticleRow_(2);
  assert.equal(r.status, '要確認');
  assert.match(r.resultMessage, /要確認：.*短すぎます.*書き直しに失敗したため、前回の記事を保存しました/);
  assert.equal(env.state.fetchCalls.length, 4, '1記事の呼び出し上限4回で打ち切る');
});

test('呼び出し回数の上限：書き直し前に上限へ達していたら書き直しを省略する', () => {
  const env = timedEnv(1000, (i) => (i < 3
    ? claudeError(503, 'api_error', 'unavailable')
    : claudeSuccess(makeArticle({ sectionChars: 300 }))));
  const res = env.gas.generateArticleForRow_(2);
  assert.equal(res.ok, true);
  assert.equal(env.state.fetchCalls.length, 4);
  assert.match(env.gas.getArticleRow_(2).resultMessage, /呼び出し回数の上限に達したため、書き直しを省略/);
});

test('書き直しは残り時間が足りなければ省略し、その旨を表示する', () => {
  const env = timedEnv(200 * 1000, () => claudeSuccess(makeArticle({ sectionChars: 300 })));
  env.gas.generateArticleForRow_(2);
  assert.equal(env.state.fetchCalls.length, 1);
  assert.match(env.gas.getArticleRow_(2).resultMessage, /実行時間の上限が近いため、書き直しを省略/);
});

test('通信例外はAPIキーをログに残さず、未設定モデルの費用は「単価未登録」', () => {
  const env = timedEnv(1000, () => claudeSuccess(makeArticle(), { model: 'claude-custom' }),
    Object.assign({}, BASE_PROPS, { CLAUDE_MODEL: 'claude-custom' }));
  env.gas.generateArticleForRow_(2);
  const row = env.spreadsheet.getSheetByName('記事本文').getRange(2, 1, 1, 12).getValues()[0];
  assert.equal(row[11], '単価未登録');
  assert.equal(httpResponse(200, {}).getResponseCode(), 200);
});
