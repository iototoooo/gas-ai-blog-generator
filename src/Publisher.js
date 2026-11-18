/**
 * Publisher.js
 * 生成済み記事を WordPress に「下書き」として保存する。
 */

/**
 * @param {number} rowNumber
 * @param {Object} [options]
 * @param {Object} [options.deadline]
 * @return {{ok:boolean, skipped?:boolean, id?:string, message:string}}
 */
function postDraftForRow_(rowNumber, options) {
  options = options || {};
  var deadline = options.deadline || createDeadline_();
  var settings = getSettings_();

  // WordPress 未接続でもエラーにはせず、スプレッドシート運用を続けられるようにする
  if (!isWordPressConfigured_(settings)) {
    return {
      ok: false, skipped: true,
      message: 'WordPressが未設定のため下書き保存をスキップしました。記事は「記事本文」シートで確認できます。'
    };
  }

  var article = claimArticleRow_(rowNumber, {
    allowed: [STATUS.GENERATED, STATUS.POST_ERROR],
    processing: STATUS.POSTING,
    extraCheck: function (a) {
      return a.wpPostId ? '既にWordPressへ保存済みです（投稿ID: ' + a.wpPostId + '）。' : null;
    }
  });

  try {
    var body = getArticleBody_(article.id);
    if (!body || !body.bodyHtml) {
      throw createAppError_('NOT_FOUND', '「記事本文」シートに ' + article.id + ' の本文がありません。記事を再生成してください。');
    }
    var slug = buildWpSlug_(article.id);

    // 前回の投稿が「WordPress側では成功・応答は失敗」だった場合に備え、先に同じスラッグを検索する
    var post = wpFindPostBySlug_(settings, slug, deadline);
    var linkedExisting = !!post;
    if (!post) {
      post = wpCreateDraft_(settings, {
        title: article.title || body.title,
        content: body.bodyHtml,
        excerpt: article.metaDescription || body.metaDescription,
        slug: slug
      }, deadline);
    }

    var message = linkedExisting
      ? 'WordPress上に同じ記事（' + slug + '）があったため、新規投稿せずに紐付けました。'
      : 'WordPressに下書き保存しました。';
    if (post.status && post.status !== WP_DRAFT_STATUS) {
      message += '（注意：WordPress上のステータスが「' + post.status + '」です。管理画面で確認してください）';
    }

    updateArticleFields_(rowNumber, {
      STATUS: STATUS.DRAFT_SAVED,
      WP_POST_ID: String(post.id),
      WP_URL: buildWpEditUrl_(settings, post.id),
      RESULT_MESSAGE: message
    });
    appendLog_(article.id, '下書き保存', '成功', message + ' 投稿ID: ' + post.id);
    return { ok: true, id: article.id, message: message };
  } catch (e) {
    var userMessage = toUserMessage_(e, getSecretValues_(settings));
    updateArticleFields_(rowNumber, {
      STATUS: STATUS.POST_ERROR,
      RESULT_MESSAGE: userMessage
    });
    appendLog_(article.id, '下書き保存', '失敗', userMessage);
    return { ok: false, id: article.id, message: userMessage, code: e.code };
  }
}
