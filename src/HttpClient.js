/**
 * HttpClient.js
 * UrlFetchApp のラッパー。リトライ・レート制限・認証エラー・実行時間制限をまとめて扱う。
 */

var RETRYABLE_STATUS_CODES = [408, 500, 502, 503, 504, 529];

/**
 * @param {string} url
 * @param {Object} options UrlFetchApp.fetch のオプション（muteHttpExceptions は自動で true）
 * @param {Object} ctx
 * @param {string} ctx.service 表示用のサービス名
 * @param {Object} ctx.deadline createDeadline_() の戻り値
 * @param {string[]} ctx.secrets エラーメッセージから伏せる値
 * @param {boolean} [ctx.retryAmbiguous=true] 通信エラーや5xxでも再送するか。
 *        投稿作成のように「相手側で処理済みかもしれない」リクエストでは false にする。
 * @param {number} [ctx.maxRetries]
 * @param {Object} [ctx.callBudget] { remainingCalls, calls } 呼び出し回数の上限管理（記事単位で共有）
 * @return {{code:number, json:Object, text:string, response:Object}}
 */
function fetchWithRetry_(url, options, ctx) {
  var maxRetries = ctx.maxRetries === undefined ? RUNTIME_LIMITS.HTTP_MAX_RETRIES : ctx.maxRetries;
  var retryAmbiguous = ctx.retryAmbiguous !== false;
  var deadline = ctx.deadline || createDeadline_();
  var fetchOptions = Object.assign({}, options, { muteHttpExceptions: true });
  var lastError = null;

  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    if (!deadline.hasTimeFor(RUNTIME_LIMITS.MIN_TIME_FOR_API_CALL_MS)) {
      throw createAppError_('TIMEOUT',
        'GASの実行時間の上限が近いため、' + ctx.service + 'の呼び出しを中止しました。もう一度実行してください。' +
        (lastError ? '（直前のエラー: ' + lastError.message + '）' : ''));
    }

    if (ctx.callBudget) {
      if (ctx.callBudget.remainingCalls <= 0) {
        throw createAppError_('CALL_LIMIT',
          ctx.service + 'の呼び出し回数が1記事あたりの上限に達したため中止しました。時間をおいて再実行してください。' +
          (lastError ? '（直前のエラー: ' + lastError.message + '）' : ''));
      }
      ctx.callBudget.remainingCalls--;
      ctx.callBudget.calls++;
    }

    var error;
    try {
      var response = UrlFetchApp.fetch(url, fetchOptions);
      var result = interpretResponse_(response, ctx);
      if (result.ok) return result;
      error = result.error;
    } catch (e) {
      if (isAppError_(e)) throw e;
      error = createAppError_('NETWORK_ERROR',
        ctx.service + 'との通信に失敗しました: ' + maskSecrets_(e.message, ctx.secrets),
        { retryable: retryAmbiguous });
    }

    lastError = error;
    var canRetry = error.retryable && (error.code === 'RATE_LIMIT' || retryAmbiguous);
    if (!canRetry || attempt === maxRetries) throw error;

    var waitMs = computeBackoffMs_(attempt, error.retryAfterMs);
    if (!deadline.hasTimeFor(waitMs + RUNTIME_LIMITS.MIN_TIME_FOR_API_CALL_MS)) {
      throw createAppError_('TIMEOUT',
        'GASの実行時間の上限が近いため、' + ctx.service + 'の再試行を中止しました。時間をおいて再実行してください。（直前のエラー: ' +
        error.message + '）', { status: error.status });
    }
    console.warn(ctx.service + ' 再試行 ' + (attempt + 1) + '/' + maxRetries + '（' + waitMs + 'ms待機）: ' + error.code);
    sleepMs_(waitMs);
  }
  throw lastError;
}

function interpretResponse_(response, ctx) {
  var code = response.getResponseCode();
  var text = response.getContentText() || '';
  var parsed = safeJsonParse_(text);
  var json = parsed.ok ? parsed.value : null;

  if (code >= 200 && code < 300) {
    return { ok: true, code: code, json: json, text: text, response: response };
  }

  var apiMessage = extractApiErrorMessage_(json, text);
  var detail = maskSecrets_(apiMessage, ctx.secrets);

  if (code === 401 || code === 403) {
    return {
      ok: false, error: createAppError_('AUTH_ERROR',
        ctx.service + 'の認証に失敗しました（HTTP ' + code + '）。Script Properties の認証情報を確認してください。詳細: ' + detail,
        { status: code })
    };
  }
  if (code === 429) {
    return {
      ok: false, error: createAppError_('RATE_LIMIT',
        ctx.service + 'のレート制限に達しました（HTTP 429）。詳細: ' + detail,
        { status: code, retryable: true, retryAfterMs: parseRetryAfterMs_(getHeader_(response, 'retry-after')) })
    };
  }
  var retryable = RETRYABLE_STATUS_CODES.indexOf(code) !== -1;
  return {
    ok: false, error: createAppError_(ctx.errorCode || 'API_ERROR',
      ctx.service + 'がエラーを返しました（HTTP ' + code + '）。詳細: ' + detail,
      { status: code, retryable: retryable, retryAfterMs: parseRetryAfterMs_(getHeader_(response, 'retry-after')) })
  };
}

function extractApiErrorMessage_(json, text) {
  if (json) {
    if (json.error && json.error.message) return String(json.error.message);
    if (json.message) return String(json.message);
  }
  return truncate_(text, 200) || '(本文なし)';
}
