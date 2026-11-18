/**
 * Utils.js
 * 共通ユーティリティ（エラー生成、時間管理、マスキング、文字数カウント）。
 */

/** テスト時に差し替え可能な時計 */
var Clock_ = {
  now: function () { return Date.now(); }
};

/**
 * アプリケーション共通のエラーを作る。
 * code: CONFIG_MISSING / AUTH_ERROR / RATE_LIMIT / API_ERROR / NETWORK_ERROR /
 *       TIMEOUT / INVALID_RESPONSE / REFUSAL / TRUNCATED / LOCK_TIMEOUT /
 *       INVALID_STATE / WP_ERROR / NOT_FOUND
 */
function createAppError_(code, message, options) {
  var e = new Error(message);
  e.name = 'AppError';
  e.code = code;
  e.retryable = !!(options && options.retryable);
  e.status = options && options.status ? options.status : null;
  e.retryAfterMs = options && options.retryAfterMs ? options.retryAfterMs : null;
  return e;
}

function isAppError_(e) {
  return !!(e && e.name === 'AppError' && e.code);
}

/** 利用者向けのエラーメッセージ（秘密情報はマスク） */
function toUserMessage_(e, secrets) {
  var prefix = isAppError_(e) ? '[' + e.code + '] ' : '[UNEXPECTED] ';
  var msg = (e && e.message) ? String(e.message) : String(e);
  return truncate_(maskSecrets_(prefix + msg, secrets || []), 500);
}

/** 文字列中の秘密情報を伏せ字にする */
function maskSecrets_(text, secrets) {
  var out = String(text);
  (secrets || []).forEach(function (s) {
    if (s && s.length >= 4) out = out.split(s).join('****');
  });
  // 念のため、Anthropic APIキーの形式も伏せる
  out = out.replace(/sk-ant-[A-Za-z0-9_\-]+/g, 'sk-ant-****');
  return out;
}

/** 設定状況の表示用。値そのものは一切表示しない */
function describeSecret_(value) {
  return value ? '設定済み' : '未設定';
}

function truncate_(text, maxLen) {
  var s = String(text === null || text === undefined ? '' : text);
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

function getTimeZone_() {
  try {
    return Session.getScriptTimeZone() || 'Asia/Tokyo';
  } catch (e) {
    return 'Asia/Tokyo';
  }
}

function formatDateTime_(date) {
  return Utilities.formatDate(date || new Date(Clock_.now()), getTimeZone_(), 'yyyy/MM/dd HH:mm:ss');
}

/** 締め切り（GASの実行時間制限）を管理するオブジェクト */
function createDeadline_(totalMs) {
  var start = Clock_.now();
  var limit = totalMs || RUNTIME_LIMITS.MAX_RUNTIME_MS;
  return {
    elapsed: function () { return Clock_.now() - start; },
    remaining: function () { return limit - (Clock_.now() - start); },
    hasTimeFor: function (ms) { return this.remaining() >= ms; }
  };
}

/**
 * リトライ待機時間を計算する。
 * Retry-After ヘッダー（秒）があればそれを優先、なければ指数バックオフ＋ジッター。
 */
function computeBackoffMs_(attempt, retryAfterMs) {
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.min(retryAfterMs, RUNTIME_LIMITS.MAX_BACKOFF_MS);
  }
  var base = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s...
  var jitter = Math.floor(Math.random() * 500);
  return Math.min(base + jitter, RUNTIME_LIMITS.MAX_BACKOFF_MS);
}

function parseRetryAfterMs_(headerValue) {
  if (headerValue === null || headerValue === undefined || headerValue === '') return null;
  var sec = parseFloat(headerValue);
  return isNaN(sec) ? null : Math.max(0, Math.round(sec * 1000));
}

/** レスポンスヘッダーを大文字小文字を無視して取得する */
function getHeader_(response, name) {
  var headers = {};
  try {
    headers = response.getAllHeaders ? response.getAllHeaders() : response.getHeaders();
  } catch (e) {
    return null;
  }
  var lower = name.toLowerCase();
  for (var k in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, k) && k.toLowerCase() === lower) {
      var v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return null;
}

function sleepMs_(ms) {
  if (ms > 0) Utilities.sleep(ms);
}

/**
 * 記事の文字数を数える。
 * 空白・改行・Markdown記号（見出し#、箇条書き-）を除いた文字数。
 */
function countArticleChars_(text) {
  return String(text || '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*・]\s+/gm, '')
    .replace(/\s/g, '')
    .length;
}

function safeJsonParse_(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e };
  }
}
