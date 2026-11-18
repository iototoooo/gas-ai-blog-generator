/**
 * ClaudeClient.js
 * Claude Messages API の呼び出し。GAS には公式SDKがないため REST API を直接呼ぶ。
 */

var CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
var CLAUDE_API_VERSION = '2026-10-21';
/** 安全性分類器による拒否（refusal）時に、サーバー側で別モデルに切り替えて続行する機能 */
var CLAUDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * リクエスト（URLとオプション）を組み立てる。APIキーはヘッダーにのみ入れ、本文には入れない。
 */
function buildClaudeRequest_(settings, systemPrompt, userPrompt) {
  var body = {
    model: settings.claudeModel,
    max_tokens: settings.claudeMaxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    output_config: {
      effort: settings.claudeEffort,
      format: { type: 'json_schema', schema: ARTICLE_SCHEMA }
    }
  };
  var headers = {
    'x-api-key': settings.claudeApiKey,
    'anthropic-version': CLAUDE_API_VERSION
  };
  if (settings.claudeUseFallback) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = CLAUDE_FALLBACK_BETA;
  }
  return {
    url: CLAUDE_API_URL,
    options: {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify(body)
    }
  };
}

/**
 * 使用量メーター（1記事単位）。API呼び出し回数の上限管理と、課金対象トークンの集計を兼ねる。
 */
function createUsageMeter_(maxCalls) {
  return {
    remainingCalls: maxCalls || CLAUDE_DEFAULTS.MAX_API_CALLS_PER_ARTICLE,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    model: ''
  };
}

/**
 * 記事を1本生成する（API呼び出し＋レスポンス解析）。
 * HTTP 200 の応答は、応答拒否・途中切れ・JSON不正で例外になる場合も課金されるため、先にメーターへ記録する。
 * @return {{article:Object, usage:Object, model:string}}
 */
function requestArticleFromClaude_(settings, systemPrompt, userPrompt, deadline, meter) {
  meter = meter || createUsageMeter_();
  var req = buildClaudeRequest_(settings, systemPrompt, userPrompt);
  var result = fetchWithRetry_(req.url, req.options, {
    service: 'Claude API',
    deadline: deadline,
    secrets: getSecretValues_(settings),
    callBudget: meter
  });
  var usage = (result.json && result.json.usage) || {};
  meter.inputTokens += Number(usage.input_tokens || 0);
  meter.outputTokens += Number(usage.output_tokens || 0);
  meter.model = (result.json && result.json.model) || settings.claudeModel;
  return parseClaudeResponse_(result.json);
}

function parseClaudeResponse_(json) {
  if (!json || !Array.isArray(json.content)) {
    throw createAppError_('INVALID_RESPONSE', 'Claude APIの応答形式が想定と異なります。');
  }
  if (json.stop_reason === 'refusal') {
    var category = json.stop_details && json.stop_details.category ? json.stop_details.category : '不明';
    throw createAppError_('REFUSAL',
      'Claudeがこのキーワードでの記事作成を控えました（分類: ' + category + '）。キーワードを見直してください。');
  }
  if (json.stop_reason === 'max_tokens') {
    throw createAppError_('TRUNCATED',
      '出力が上限に達して途中で切れました。Script Properties の CLAUDE_MAX_TOKENS を増やすか、再実行してください。');
  }

  var text = json.content
    .filter(function (b) { return b && b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('');
  if (!text) {
    throw createAppError_('INVALID_RESPONSE', 'Claude APIの応答に本文が含まれていません。');
  }

  var parsed = safeJsonParse_(text);
  if (!parsed.ok) {
    // structured outputs が使えない場合の保険として、最初の { 〜 最後の } を取り出して再解析
    var start = text.indexOf('{');
    var end = text.lastIndexOf('}');
    if (start !== -1 && end > start) parsed = safeJsonParse_(text.slice(start, end + 1));
  }
  if (!parsed.ok) {
    throw createAppError_('INVALID_RESPONSE', 'Claude APIの応答をJSONとして読み取れませんでした。再実行してください。');
  }

  return {
    article: parsed.value,
    usage: json.usage || {},
    model: json.model || ''
  };
}
