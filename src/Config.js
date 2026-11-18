/**
 * Config.js
 * シート構造・ステータス・各種上限値などの定数と、Script Properties からの設定読み込み。
 *
 * 秘密情報（APIキー・WordPressアプリケーションパスワード）は
 * 必ず Script Properties に保存し、コード・シートには書かない。
 */

/** シート名 */
var SHEET_NAMES = {
  ARTICLES: '記事管理',
  BODIES: '記事本文',
  SAMPLES: 'サンプル記事',
  LOGS: '実行ログ'
};

/** 記事管理シートの列定義（1始まり） */
var ARTICLE_COLUMNS = {
  ID: 1,
  KEYWORD: 2,
  SUB_KEYWORDS: 3,
  STATUS: 4,
  TITLE: 5,
  META_DESCRIPTION: 6,
  CHAR_COUNT: 7,
  WP_POST_ID: 8,
  WP_URL: 9,
  RESULT_MESSAGE: 10,
  STARTED_AT: 11,
  UPDATED_AT: 12,
  GENERATION_COUNT: 13
};

var ARTICLE_HEADERS = [
  'ID', 'キーワード', 'サブキーワード', 'ステータス', 'タイトル',
  'メタディスクリプション', '文字数', 'WordPress投稿ID', 'WordPress URL',
  '処理結果', '処理開始日時', '最終更新日時', '生成回数'
];

/** 記事本文シートの列定義 */
var BODY_COLUMNS = {
  ID: 1,
  KEYWORD: 2,
  TITLE: 3,
  BODY_MARKDOWN: 4,
  BODY_HTML: 5,
  META_DESCRIPTION: 6,
  GENERATED_AT: 7,
  MODEL: 8,
  INPUT_TOKENS: 9,
  OUTPUT_TOKENS: 10,
  API_CALLS: 11,
  ESTIMATED_COST_USD: 12
};

/** トークン数は書き直し分を含む1記事の合計（課金対象）。出力トークンには思考（thinking）分も含まれる */
var BODY_HEADERS = [
  'ID', 'キーワード', 'タイトル', '本文（Markdown）', '本文（HTML）',
  'メタディスクリプション', '生成日時', 'モデル', '入力トークン', '出力トークン',
  'API呼び出し回数', '推定費用（USD）'
];

/** サンプル記事シートの列定義 */
var SAMPLE_COLUMNS = {
  ID: 1,
  TITLE: 2,
  BODY: 3,
  ENABLED: 4,
  NOTE: 5
};

var SAMPLE_HEADERS = ['サンプルID', 'タイトル', '本文', '利用する', 'メモ'];

var LOG_HEADERS = ['日時', 'ID', '処理', '結果', '詳細'];

/** 処理ステータス */
var STATUS = {
  NOT_GENERATED: '未生成',
  GENERATING: '生成中',
  GENERATED: '生成済み',
  /** 書き直しても文字数・見出し数などの必須条件を満たさなかった記事（WordPress へは保存しない） */
  NEEDS_REVIEW: '要確認',
  POSTING: '投稿中',
  DRAFT_SAVED: '下書き保存済み',
  GENERATION_ERROR: '生成エラー',
  POST_ERROR: '投稿エラー'
};

var STATUS_LIST = [
  STATUS.NOT_GENERATED, STATUS.GENERATING, STATUS.GENERATED, STATUS.NEEDS_REVIEW, STATUS.POSTING,
  STATUS.DRAFT_SAVED, STATUS.GENERATION_ERROR, STATUS.POST_ERROR
];

/** 記事の仕様 */
var ARTICLE_RULES = {
  MIN_CHARS: 2000,
  MAX_CHARS: 3000,
  TARGET_CHARS: 2500,
  SECTION_COUNT: 3,
  META_MAX_CHARS: 120,
  /** サンプル記事との一致を検出する連続文字数 */
  SAMPLE_OVERLAP_NGRAM: 25
};

/** 実行時間・リトライ関連 */
var RUNTIME_LIMITS = {
  /** GAS の上限は6分。余裕を持って4分30秒で新規処理の開始を止める */
  MAX_RUNTIME_MS: 270 * 1000,
  /** 1記事の生成に見込む時間。残りがこれ未満なら次の記事に着手しない */
  PER_ARTICLE_BUDGET_MS: 120 * 1000,
  /** APIを1回呼ぶのに最低限必要な残り時間 */
  MIN_TIME_FOR_API_CALL_MS: 45 * 1000,
  /** 「生成中」「投稿中」のまま放置されたとみなす時間 */
  STALE_PROCESSING_MS: 10 * 60 * 1000,
  /** ロック取得の待ち時間 */
  LOCK_WAIT_MS: 10 * 1000,
  /** HTTPリトライ回数（初回を除く） */
  HTTP_MAX_RETRIES: 3,
  /** バックオフの上限 */
  MAX_BACKOFF_MS: 30 * 1000,
  /** 一括生成で1回に処理する最大件数 */
  MAX_BATCH_SIZE: 5,
  /** 一括処理の記事間の待機（レート制限対策） */
  BATCH_INTERVAL_MS: 1000
};

/** Claude API 既定値（Script Properties で上書き可） */
var CLAUDE_DEFAULTS = {
  /** 低価格・高速な Haiku を既定にし、品質不足なら CLAUDE_MODEL=claude-sonnet-5-5 に切り替える */
  MODEL: 'claude-haiku-5-5',
  EFFORT: 'medium',
  MAX_TOKENS: 16000,
  USE_FALLBACK: true,
  MAX_GENERATION_ATTEMPTS: 2,
  /** 1記事あたりの Claude API 呼び出し回数の上限（書き直し・HTTP再試行をすべて含む） */
  MAX_API_CALLS_PER_ARTICLE: 4
};

/**
 * モデルごとの仕様と単価（USD / 100万トークン）。
 * 単価は 2026-11-03 時点の公表値（Claude API 直接利用・標準料金）。改定時はここを更新する。
 * supportsFallback: サーバー側フォールバック（fallbacks パラメータ）に対応しているか。
 *   Haiku 5.5 は非対応（"default" は効果がなく、モデル指定形式は400エラー）。
 * Haiku 5.5 はプロンプトが10万トークンを超えると単価が上がる（本システムのプロンプトは数千トークン）。
 */
var MODEL_PROFILES = {
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5', supportsFallback: false, inputPerMTok: 0.10, outputPerMTok: 0.50 },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', supportsFallback: true, inputPerMTok: 2.00, outputPerMTok: 10.00 },
  'claude-opus-5-5': { label: 'Claude Opus 5.5', supportsFallback: true, inputPerMTok: 4.00, outputPerMTok: 20.00 }
};

function getModelProfile_(model) {
  return Object.prototype.hasOwnProperty.call(MODEL_PROFILES, model) ? MODEL_PROFILES[model] : null;
}

/** 推定費用（USD）。単価が未登録のモデルは null */
function estimateCostUsd_(model, inputTokens, outputTokens) {
  var p = getModelProfile_(model);
  if (!p) return null;
  var cost = (Number(inputTokens || 0) * p.inputPerMTok + Number(outputTokens || 0) * p.outputPerMTok) / 1000000;
  return Math.round(cost * 1000000) / 1000000;
}

/**
 * プロンプトの版。v1＝初期版（比較用に保存）、v2＝具体性・実行可能性・検索意図・導線・事実性を強化した版。
 * Script Properties の PROMPT_VERSION で切り替え、改善前後の記事を比較できる。
 */
var PROMPT_VERSIONS = ['v1', 'v2'];
var DEFAULT_PROMPT_VERSION = 'v2';

/**
 * 記事の最後で紹介する自社サービス（Script Properties で上書き可）。
 * 機能・料金・実績は SERVICE_FACTS に書いた内容だけを記事に使う（未設定なら機能説明はしない）。
 */
var SERVICE_DEFAULTS = {
  NAME: 'キンタイ Cloud',
  CATEGORY: '勤怠管理サービス'
};
/** サービス名の言及がこの回数を超えたら宣伝過多として「要確認」にする */
var SERVICE_MENTION_MAX = 2;

/** Script Properties のキー名 */
var PROPERTY_KEYS = {
  CLAUDE_API_KEY: 'CLAUDE_API_KEY',
  CLAUDE_MODEL: 'CLAUDE_MODEL',
  CLAUDE_EFFORT: 'CLAUDE_EFFORT',
  CLAUDE_MAX_TOKENS: 'CLAUDE_MAX_TOKENS',
  CLAUDE_USE_FALLBACK: 'CLAUDE_USE_FALLBACK',
  MAX_GENERATION_ATTEMPTS: 'MAX_GENERATION_ATTEMPTS',
  PROMPT_VERSION: 'PROMPT_VERSION',
  SERVICE_NAME: 'SERVICE_NAME',
  SERVICE_CATEGORY: 'SERVICE_CATEGORY',
  SERVICE_FACTS: 'SERVICE_FACTS',
  WP_BASE_URL: 'WP_BASE_URL',
  WP_USERNAME: 'WP_USERNAME',
  WP_APP_PASSWORD: 'WP_APP_PASSWORD'
};

var VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Script Properties から設定を読み込む。
 * 秘密情報はこの戻り値の中だけで扱い、ログやシートには出さない。
 */
function getSettings_() {
  var props = PropertiesService.getScriptProperties();
  var get = function (key) {
    var v = props.getProperty(key);
    return v === null || v === undefined ? '' : String(v).trim();
  };

  var effort = get(PROPERTY_KEYS.CLAUDE_EFFORT) || CLAUDE_DEFAULTS.EFFORT;
  if (VALID_EFFORTS.indexOf(effort) === -1) effort = CLAUDE_DEFAULTS.EFFORT;

  var maxTokens = parseInt(get(PROPERTY_KEYS.CLAUDE_MAX_TOKENS), 10);
  if (!(maxTokens > 0)) maxTokens = CLAUDE_DEFAULTS.MAX_TOKENS;

  var attempts = parseInt(get(PROPERTY_KEYS.MAX_GENERATION_ATTEMPTS), 10);
  if (!(attempts >= 1 && attempts <= 3)) attempts = CLAUDE_DEFAULTS.MAX_GENERATION_ATTEMPTS;

  var fallbackRaw = get(PROPERTY_KEYS.CLAUDE_USE_FALLBACK).toLowerCase();
  var fallbackRequested = fallbackRaw === '' ? CLAUDE_DEFAULTS.USE_FALLBACK : fallbackRaw !== 'false';
  var model = get(PROPERTY_KEYS.CLAUDE_MODEL) || CLAUDE_DEFAULTS.MODEL;
  var profile = getModelProfile_(model);
  // フォールバックは対応モデルでのみ送る（未登録のモデルは安全側＝送らない）
  var useFallback = fallbackRequested && !!(profile && profile.supportsFallback);
  var promptVersion = get(PROPERTY_KEYS.PROMPT_VERSION).toLowerCase();
  if (PROMPT_VERSIONS.indexOf(promptVersion) === -1) promptVersion = DEFAULT_PROMPT_VERSION;

  return {
    claudeApiKey: get(PROPERTY_KEYS.CLAUDE_API_KEY),
    claudeModel: model,
    claudeEffort: effort,
    claudeMaxTokens: maxTokens,
    claudeUseFallback: useFallback,
    maxGenerationAttempts: attempts,
    promptVersion: promptVersion,
    serviceName: get(PROPERTY_KEYS.SERVICE_NAME) || SERVICE_DEFAULTS.NAME,
    serviceCategory: get(PROPERTY_KEYS.SERVICE_CATEGORY) || SERVICE_DEFAULTS.CATEGORY,
    serviceFacts: get(PROPERTY_KEYS.SERVICE_FACTS),
    wpBaseUrl: normalizeBaseUrl_(get(PROPERTY_KEYS.WP_BASE_URL)),
    wpUsername: get(PROPERTY_KEYS.WP_USERNAME),
    wpAppPassword: get(PROPERTY_KEYS.WP_APP_PASSWORD)
  };
}

function normalizeBaseUrl_(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function isClaudeConfigured_(settings) {
  return !!settings.claudeApiKey;
}

function isWordPressConfigured_(settings) {
  return !!(settings.wpBaseUrl && settings.wpUsername && settings.wpAppPassword);
}

function requireClaudeSettings_(settings) {
  if (!isClaudeConfigured_(settings)) {
    throw createAppError_('CONFIG_MISSING',
      'Claude APIキーが未設定です。「APIキー設定手順書」に沿って Script Properties に CLAUDE_API_KEY を登録してください。');
  }
}

/** 秘密情報のリスト（エラーメッセージのマスキング用） */
function getSecretValues_(settings) {
  return [settings.claudeApiKey, settings.wpAppPassword].filter(function (v) { return !!v; });
}
