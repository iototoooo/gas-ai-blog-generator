/**
 * WordPressClient.js
 * WordPress REST API（/wp-json/wp/v2/posts）への下書き投稿。
 *
 * 安全のため、投稿ステータスは定数 'draft' 固定。公開（publish）するコードは存在しない。
 */

var WP_DRAFT_STATUS = 'draft';
var WP_SLUG_PREFIX = 'aiblog-';
/** 既存記事の検索で対象にするステータス（公開済みを含めて重複を検出する） */
var WP_SEARCH_STATUSES = 'draft,pending,private,future,publish';

function assertWordPressReady_(settings) {
  if (!isWordPressConfigured_(settings)) {
    throw createAppError_('CONFIG_MISSING',
      'WordPressの接続情報（WP_BASE_URL / WP_USERNAME / WP_APP_PASSWORD）が未設定です。記事はスプレッドシートで確認できます。');
  }
  if (!/^https:\/\//i.test(settings.wpBaseUrl)) {
    throw createAppError_('CONFIG_MISSING',
      'WP_BASE_URL は https:// で始まるURLにしてください（認証情報を暗号化せずに送らないため）。');
  }
}

function buildWpAuthHeader_(settings) {
  // アプリケーションパスワードは空白入りで表示されるが、空白を含めたままでも除いても認証できる
  var token = Utilities.base64Encode(settings.wpUsername + ':' + settings.wpAppPassword);
  return 'Basic ' + token;
}

function wpRequest_(settings, method, path, payload, deadline, opts) {
  assertWordPressReady_(settings);
  var options = {
    method: method,
    headers: { Authorization: buildWpAuthHeader_(settings) }
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  return fetchWithRetry_(settings.wpBaseUrl + path, options, {
    service: 'WordPress',
    errorCode: 'WP_ERROR',
    deadline: deadline,
    secrets: getSecretValues_(settings).concat([buildWpAuthHeader_(settings)]),
    retryAmbiguous: !(opts && opts.noAmbiguousRetry)
  });
}

function buildWpSlug_(articleId) {
  return WP_SLUG_PREFIX + String(articleId).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/** 同じスラッグの投稿が既にあれば返す（二重投稿防止） */
function wpFindPostBySlug_(settings, slug, deadline) {
  var path = '/wp-json/wp/v2/posts?context=edit&slug=' + encodeURIComponent(slug) +
    '&status=' + encodeURIComponent(WP_SEARCH_STATUSES) + '&_fields=id,status,link,slug';
  var result = wpRequest_(settings, 'get', path, null, deadline);
  var list = Array.isArray(result.json) ? result.json : [];
  return list.length > 0 ? list[0] : null;
}

/**
 * 下書きを作成する。status は常に 'draft'。
 * 作成リクエストは「WordPress側では作成済みなのに応答だけ失敗した」可能性があるため自動再送しない。
 * 再実行時はスラッグ検索で既存投稿を検出する。
 */
function wpCreateDraft_(settings, post, deadline) {
  var payload = {
    title: post.title,
    content: post.content,
    excerpt: post.excerpt,
    slug: post.slug,
    status: WP_DRAFT_STATUS
  };
  if (payload.status !== 'draft') {
    throw createAppError_('INVALID_STATE', '下書き以外の投稿は許可されていません。');
  }
  var result = wpRequest_(settings, 'post', '/wp-json/wp/v2/posts', payload, deadline, { noAmbiguousRetry: true });
  if (!result.json || !result.json.id) {
    throw createAppError_('INVALID_RESPONSE', 'WordPressの応答に投稿IDが含まれていません。');
  }
  return result.json;
}

function buildWpEditUrl_(settings, postId) {
  return settings.wpBaseUrl + '/wp-admin/post.php?post=' + postId + '&action=edit';
}

/** 認証の確認（投稿はしない） */
function wpTestConnection_(settings, deadline) {
  var result = wpRequest_(settings, 'get', '/wp-json/wp/v2/users/me?context=edit&_fields=id,name,capabilities', null, deadline);
  var user = result.json || {};
  var caps = user.capabilities || {};
  return { name: user.name || '', canEditPosts: caps.edit_posts === true };
}
