'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/load-gas');
const {
  BASE_PROPS, FAKE_API_KEY, makeArticle, claudeSuccess, claudeError, httpResponse
} = require('./helpers/fixtures');

function call(env) {
  const { gas } = env;
  const settings = gas.getSettings_();
  return gas.requestArticleFromClaude_(settings, gas.buildSystemPrompt_(), 'prompt', gas.createDeadline_());
}

test('リクエスト形式（既定 Haiku 5.5）：モデル・APIバージョン・構造化出力・フォールバックなし・APIキーはヘッダーのみ', () => {
  const env = loadGas({ properties: BASE_PROPS, fetchHandler: () => claudeSuccess(makeArticle()) });
  call(env);
  const req = env.state.fetchCalls[0];
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.options.method, 'post');
  assert.equal(req.options.muteHttpExceptions, true);
  assert.equal(req.options.headers['x-api-key'], FAKE_API_KEY);
  assert.equal(req.options.headers['anthropic-version'], '2026-10-21');
  assert.equal(req.options.headers['anthropic-beta'], undefined, 'Haiku 5.5 はサーバー側フォールバック非対応');
  const body = JSON.parse(req.options.payload);
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.max_tokens, 16000);
  assert.equal(body.output_config.effort, 'medium');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.fallbacks, undefined, 'Haiku 5.5 には fallbacks を送らない');
  assert.equal(body.temperature, undefined, 'temperature は送らない（現行APIでは400）');
  assert.equal(body.thinking, undefined, 'Haiku 5.5 は省略時に adaptive thinking');
  assert.ok(!req.options.payload.includes(FAKE_API_KEY), '本文にAPIキーを含めない');
});

test('Sonnet 5.5 に切り替えるとフォールバック（"default"）が有効になる', () => {
  const env = loadGas({
    properties: Object.assign({}, BASE_PROPS, { CLAUDE_MODEL: 'claude-sonnet-5-5' }),
    fetchHandler: () => claudeSuccess(makeArticle())
  });
  call(env);
  const req = env.state.fetchCalls[0];
  const body = JSON.parse(req.options.payload);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.fallbacks, 'default');
  assert.equal(req.options.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(body.output_config.format.type, 'json_schema', '構造化出力は Sonnet でも同じ');
});

test('単価未登録のモデルではフォールバックを送らない（安全側）', () => {
  const env = loadGas({ properties: Object.assign({}, BASE_PROPS, { CLAUDE_MODEL: 'claude-unknown-model' }) });
  assert.equal(env.gas.getSettings_().claudeUseFallback, false);
});

test('出力JSON Schema：構造化出力で非対応の制約（min/max系）を使っていない', () => {
  const { gas } = loadGas();
  const forbidden = ['minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'minItems', 'maxItems', 'pattern'];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    forbidden.forEach((k) => assert.ok(!(k in node), `非対応の制約 ${k}`));
    if (node.type === 'object') assert.equal(node.additionalProperties, false, 'object は additionalProperties:false 必須');
    Object.values(node).forEach(walk);
  };
  walk(JSON.parse(JSON.stringify(gas.ARTICLE_SCHEMA)));
});

test('推定費用：モデル別単価で計算し、未登録モデルは null', () => {
  const { gas } = loadGas();
  // Haiku 5.5: 入力 $0.10 / 出力 $0.50（100万トークンあたり）
  assert.equal(gas.estimateCostUsd_('claude-haiku-5-5', 3000, 6000), 0.0033);
  // Sonnet 5.5: 入力 $2 / 出力 $10
  assert.equal(gas.estimateCostUsd_('claude-sonnet-5-5', 3000, 6000), 0.066);
  assert.equal(gas.estimateCostUsd_('claude-unknown', 3000, 6000), null);
});

test('Script Properties でモデル・effort・フォールバックを変更できる', () => {
  const env = loadGas({
    properties: Object.assign({}, BASE_PROPS, {
      CLAUDE_MODEL: 'claude-sonnet-5-5', CLAUDE_EFFORT: 'low', CLAUDE_USE_FALLBACK: 'false', CLAUDE_MAX_TOKENS: '12000'
    }),
    fetchHandler: () => claudeSuccess(makeArticle())
  });
  call(env);
  const req = env.state.fetchCalls[0];
  const body = JSON.parse(req.options.payload);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.max_tokens, 12000);
  assert.equal(body.fallbacks, undefined);
  assert.equal(req.options.headers['anthropic-beta'], undefined);
});

test('不正な effort は既定値にフォールバック', () => {
  const env = loadGas({ properties: Object.assign({}, BASE_PROPS, { CLAUDE_EFFORT: 'super' }) });
  assert.equal(env.gas.getSettings_().claudeEffort, 'medium');
});

test('成功レスポンスから記事JSONと使用トークンを取り出す（thinkingブロックは無視）', () => {
  const env = loadGas({ properties: BASE_PROPS, fetchHandler: () => claudeSuccess(makeArticle()) });
  const res = call(env);
  assert.equal(res.article.title, '勤怠管理をエクセルで続ける限界と見直しの4ステップ');
  assert.equal(res.usage.output_tokens, 3400);
});

test('429 レート制限：Retry-After に従って待機し再試行する', () => {
  const env = loadGas({
    properties: BASE_PROPS,
    fetchHandler: (url, opt, i) => (i === 0
      ? claudeError(429, 'rate_limit_error', 'Too many requests', { 'Retry-After': '3' })
      : claudeSuccess(makeArticle()))
  });
  const res = call(env);
  assert.ok(res.article);
  assert.equal(env.state.fetchCalls.length, 2);
  assert.deepEqual(env.state.sleeps, [3000]);
});

test('529 過負荷・500：指数バックオフで再試行し、上限回数で諦める', () => {
  const env = loadGas({
    properties: BASE_PROPS,
    fetchHandler: () => claudeError(529, 'overloaded_error', 'Overloaded')
  });
  assert.throws(() => call(env), (e) => e.code === 'API_ERROR' && e.status === 529);
  assert.equal(env.state.fetchCalls.length, 4, '初回＋再試行3回');
  assert.equal(env.state.sleeps.length, 3);
});

test('401 認証エラー：再試行せず AUTH_ERROR。メッセージにAPIキーを含めない', () => {
  const env = loadGas({
    properties: BASE_PROPS,
    fetchHandler: () => claudeError(401, 'authentication_error', `invalid x-api-key ${FAKE_API_KEY}`)
  });
  assert.throws(() => call(env), (e) => {
    assert.equal(e.code, 'AUTH_ERROR');
    assert.ok(!e.message.includes(FAKE_API_KEY));
    return true;
  });
  assert.equal(env.state.fetchCalls.length, 1);
});

test('400 リクエストエラー：再試行しない', () => {
  const env = loadGas({ properties: BASE_PROPS, fetchHandler: () => claudeError(400, 'invalid_request_error', 'bad') });
  assert.throws(() => call(env), (e) => e.code === 'API_ERROR' && e.status === 400);
  assert.equal(env.state.fetchCalls.length, 1);
});

test('通信例外：再試行して成功する', () => {
  const env = loadGas({
    properties: BASE_PROPS,
    fetchHandler: (u, o, i) => { if (i === 0) throw new Error('Address unavailable'); return claudeSuccess(makeArticle()); }
  });
  assert.ok(call(env).article);
  assert.equal(env.state.fetchCalls.length, 2);
});

test('実行時間が残り少ない場合は再試行せず TIMEOUT', () => {
  const env = loadGas({
    properties: BASE_PROPS,
    fetchHandler: () => { env.advance(240 * 1000); return claudeError(503, 'api_error', 'unavailable'); }
  });
  env.setNow(Date.UTC(2026, 10, 16, 0, 0, 0));
  assert.throws(() => call(env), (e) => e.code === 'TIMEOUT');
  assert.equal(env.state.fetchCalls.length, 1);
});

test('stop_reason=refusal は REFUSAL、max_tokens は TRUNCATED', () => {
  const refusal = loadGas({
    properties: BASE_PROPS,
    fetchHandler: () => claudeSuccess(makeArticle(), { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } })
  });
  assert.throws(() => call(refusal), (e) => e.code === 'REFUSAL' && /cyber/.test(e.message));

  const truncated = loadGas({
    properties: BASE_PROPS,
    fetchHandler: () => claudeSuccess(makeArticle(), { stop_reason: 'max_tokens' })
  });
  assert.throws(() => call(truncated), (e) => e.code === 'TRUNCATED');
});

test('JSONが壊れている場合は INVALID_RESPONSE。前後に文章があっても抽出できる', () => {
  const broken = loadGas({
    properties: BASE_PROPS,
    fetchHandler: () => httpResponse(200, { content: [{ type: 'text', text: '{"title": "途中で' }], stop_reason: 'end_turn' })
  });
  assert.throws(() => call(broken), (e) => e.code === 'INVALID_RESPONSE');

  const wrapped = loadGas({
    properties: BASE_PROPS,
    fetchHandler: () => httpResponse(200, {
      content: [{ type: 'text', text: '以下です。\n' + JSON.stringify(makeArticle()) + '\n以上' }], stop_reason: 'end_turn'
    })
  });
  assert.ok(call(wrapped).article.title);
});
