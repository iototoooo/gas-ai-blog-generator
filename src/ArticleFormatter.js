/**
 * ArticleFormatter.js
 * Claude の出力（JSON）の検証と、Markdown / HTML への変換。
 */

var SUMMARY_HEADING = 'まとめ';

/** 出力JSONの必須項目を確認し、整形した記事オブジェクトを返す */
function normalizeArticle_(raw) {
  if (!raw || typeof raw !== 'object') {
    throw createAppError_('INVALID_RESPONSE', '記事データが空です。');
  }
  var str = function (v) { return typeof v === 'string' ? v.trim() : ''; };
  var sections = Array.isArray(raw.sections) ? raw.sections : [];
  var article = {
    title: str(raw.title),
    metaDescription: str(raw.meta_description).replace(/\s+/g, ' '),
    introduction: str(raw.introduction),
    sections: sections.map(function (s) {
      return { heading: str(s && s.heading).replace(/^#+\s*/, ''), body: str(s && s.body) };
    }),
    summary: str(raw.summary)
  };
  var missing = [];
  if (!article.title) missing.push('タイトル');
  if (!article.metaDescription) missing.push('メタディスクリプション');
  if (!article.introduction) missing.push('導入');
  if (!article.summary) missing.push('まとめ');
  if (article.sections.some(function (s) { return !s.heading || !s.body; })) missing.push('見出しまたは本文');
  if (missing.length > 0) {
    throw createAppError_('INVALID_RESPONSE', '記事データに不足があります: ' + missing.join('、'));
  }
  return article;
}

/** 文字数カウント対象（導入＋H2見出し＋本文＋まとめ）のプレーンテキスト */
function articleToPlainText_(article) {
  var parts = [article.introduction];
  article.sections.forEach(function (s) { parts.push(s.heading, s.body); });
  parts.push(SUMMARY_HEADING, article.summary);
  return parts.join('\n');
}

/**
 * メタディスクリプションを120文字以内に収める。
 * 超えた場合は120文字以内の最後の句点で切り、句点がなければ末尾を「…」にする。
 */
function fitMetaDescription_(meta) {
  var max = ARTICLE_RULES.META_MAX_CHARS;
  var chars = Array.from(meta);
  if (chars.length <= max) return { text: meta, trimmed: false };
  var head = chars.slice(0, max).join('');
  var lastPeriod = head.lastIndexOf('。');
  var text = lastPeriod >= max * 0.6 ? head.slice(0, lastPeriod + 1) : chars.slice(0, max - 1).join('') + '…';
  return { text: text, trimmed: true };
}

/**
 * 記事が仕様を満たすか検証する。
 * errors: 再生成で直すべき問題 / warnings: 保存はするが人の確認が必要な問題
 */
function validateArticle_(article, keyword, sampleText, serviceName) {
  var errors = [];
  var warnings = [];
  var r = ARTICLE_RULES;
  var charCount = countArticleChars_(articleToPlainText_(article));

  if (article.sections.length !== r.SECTION_COUNT) {
    errors.push('H2見出しが' + article.sections.length + '個でした。ちょうど' + r.SECTION_COUNT + '個にしてください。');
  }
  if (charCount < r.MIN_CHARS) {
    errors.push('本文が' + charCount + '文字で短すぎます（空白・改行を除いて数えています）。' + r.MIN_CHARS + '〜' + r.MAX_CHARS + '文字にするため、' +
      '目安' + r.TARGET_CHARS + '文字まで約' + (r.TARGET_CHARS - charCount) + '文字を、各H2の本文に具体例や手順の説明として分けて足してください。');
  } else if (charCount > r.MAX_CHARS) {
    errors.push('本文が' + charCount + '文字で長すぎます（空白・改行を除いて数えています）。' + r.MIN_CHARS + '〜' + r.MAX_CHARS + '文字にするため、' +
      '目安' + r.TARGET_CHARS + '文字まで約' + (charCount - r.TARGET_CHARS) + '文字を、重複した説明を中心に削ってください。');
  }
  var metaLength = Array.from(article.metaDescription).length;
  if (metaLength > r.META_MAX_CHARS) {
    errors.push('メタディスクリプションが' + metaLength + '文字です。' + r.META_MAX_CHARS + '文字以内にしてください。');
  }

  var mainKeyword = String(keyword || '').split(/[\s　]+/)[0];
  if (mainKeyword && article.title.indexOf(mainKeyword) === -1) {
    warnings.push('タイトルにメインキーワード「' + mainKeyword + '」が含まれていません。');
  }
  var overlaps = findSampleOverlaps_(articleToPlainText_(article), sampleText, r.SAMPLE_OVERLAP_NGRAM);
  if (overlaps.length > 0) {
    warnings.push('サンプル記事と' + r.SAMPLE_OVERLAP_NGRAM + '文字以上一致する箇所があります（例:「' + truncate_(overlaps[0], 30) + '」）。');
  }

  // 以下は書き直し（再課金）の対象にせず、「注意」として人が確認する項目
  var plain = [article.title, article.metaDescription, articleToPlainText_(article)].join('\n');
  var mentions = countServiceMentions_(plain, serviceName);
  if (mentions > SERVICE_MENTION_MAX) {
    warnings.push('サービス名「' + serviceName + '」が' + mentions + '回出てきます（' + SERVICE_MENTION_MAX + '回以内が目安）。宣伝が強すぎないか確認してください。');
  }
  var hype = findHypeExpressions_(plain);
  if (hype.length > 0) {
    warnings.push('誇大・断定表現があります（' + hype.join('、') + '）。');
  }
  var assertive = findHypeExpressions_(plain, ASSERTION_PATTERNS);
  if (assertive.length > 0) {
    warnings.push('効果・費用を断定している可能性があります（「' + assertive.map(function (x) { return truncate_(x, 30); }).join('」「') + '」）。');
  }
  var estimates = findEstimateIssues_(articleEstimateSegments_(article));
  if (estimates.unlabeled.length > 0) {
    warnings.push('試算・計算例の近くに「仮の数値」である旨の注記が見当たりません（' + estimates.unlabeled.length + 'か所。例:「' +
      truncate_(estimates.unlabeled[0], 30) + '」）。実績値と誤解されないよう、例の直前に注記を入れてください。');
  }
  if (estimates.ambiguous.length > 0) {
    warnings.push('数値を使った例が、仮の数値か法令などの実際の数値か自動では判断できません（' + estimates.ambiguous.length + 'か所。例:「' +
      truncate_(estimates.ambiguous[0], 30) + '」）。仮の数値なら近くに注記を入れ、法令の数値なら公的資料と一致するか確認してください。');
  }

  return { errors: errors, warnings: warnings, charCount: charCount, metaLength: metaLength, overlaps: overlaps, serviceMentions: mentions };
}

/** サービス名の出現回数（空白の有無・全角半角の違いを無視） */
function countServiceMentions_(text, serviceName) {
  if (!serviceName) return 0;
  var norm = function (x) { return String(x).replace(/[\s　]/g, '').normalize('NFKC').toLowerCase(); };
  var name = norm(serviceName);
  if (!name) return 0;
  return norm(text).split(name).length - 1;
}

/** 根拠なく使うと誤解を招く誇大・断定表現 */
var HYPE_PATTERNS = [/絶対(に)?/, /100\s*[%％]/, /No\.?\s*1(?!\d)|ナンバーワン/i, /業界(最安|初|一)/, /日本一/, /確実に/];

/** 職場によって異なる効果・費用・手間を言い切る表現（例：「費用は要らず」「効果は翌月…確認できます」） */
var ASSERTION_PATTERNS = [
  /(費用|コスト|お金)[^。、]{0,8}(かかりません|かからず|要らず|要りません|いりません|不要です|不要で)/,
  /体制[^。、]{0,8}(変更は要らず|変更は不要|変えずに済みます)/,
  /効果[^。]{0,20}(確認できます|実感できます|出ます|現れます)/
];

function findHypeExpressions_(text, patterns) {
  var found = [];
  var t = String(text).normalize('NFKC');
  (patterns || HYPE_PATTERNS).forEach(function (re) {
    var m = t.match(re);
    if (m && found.indexOf(m[0]) === -1) found.push(m[0]);
  });
  return found;
}

/*
 * 「仮の数値」チェック
 * 仮定した人数・日数・金額などを使った試算・計算例に、近くに「仮の数値」の注記がないものを探す。
 * - 日付（毎月25日締め）・時刻（9時から）・条文番号（第36条）の数値は対象外
 * - 法令の文脈の数値（「原則の上限は月45時間とされています」）は、仮定の言葉が強くなければ対象外
 * - 仮か実際の数値か判断できない例は、安全とみなさず「判断できない」として報告する（→「注意」）
 * - 注記は記事のどこかにあればよいのではなく、同じ導入・H2・まとめの中で、例の直前（6文以内）か直後（1文）に必要
 */
var ESTIMATE_UNIT_SRC = '(?:人|名|時間|日|分|円|万円|件|回|%|か月|ヶ月|カ月)';
var NUMBER_WITH_UNIT_RE = new RegExp('\\d+(?:\\.\\d+)?\\s*' + ESTIMATE_UNIT_SRC);
/** 数値チェックの前に取り除く、仮の数値ではない数値（日付・時刻・条文番号・年） */
var ESTIMATE_EXCLUDE_RES = [
  /(?:\d{4}年)?\d{1,2}月\d{1,2}日/g,
  /(?:毎月|翌月|当月|前月|同月|月末|月初)\s*\d{1,2}日/g,
  /\d{1,2}日に?(?:締|〆|払|支給|支払)/g,
  /\d{1,2}:\d{2}/g,
  /\d{1,2}時(?:\d{1,2}分)?(?:から|まで|〜|~|-|ー|に|台|以降|以前|半|頃|ごろ)/g,
  /第\s*\d+\s*(?:条|項|号)/g,
  /\d{4}年/g
];
/** 仮定・試算であることがはっきりしている表現 */
var ESTIMATE_STRONG_RE = new RegExp([
  '仮に', '試算', '計算例', '計算すると', 'と仮定', 'としたら', 'とすると',
  'ある(?:月|週|日|職場|会社|部署|社員|従業員|チーム|事業所)',
  '(?:従業員|社員|スタッフ|パート)(?:が|は)?\\d+(?:名|人)',
  '\\d+(?:名|人)(?:規模)?の(?:職場|会社|チーム|部署|事業所|企業)',
  '\\d[^。\\d]{0,4}[×÷*]\\s*\\d',
  '=\\s*\\d'
].join('|'));
/** 「…場合、取得率は50%になります」のような、条件から結果の数値を導く表現 */
var ESTIMATE_RESULT_RE = new RegExp('(?:場合|なら|すると)[^。]*\\d+(?:\\.\\d+)?\\s*' + ESTIMATE_UNIT_SRC + '\\s*(?:に|と)なり');
/** 例示の言葉（これだけでは仮の数値とも法令の数値とも決められない） */
var ESTIMATE_WEAK_RE = /たとえば|例えば|例として|場合|で計算/;
/** 法令・制度の文脈 */
var LEGAL_CONTEXT_RE = /法律|法令|労働基準|労基法|法定|法改正|条文|第\d+条|協定|上限|義務|罰則|規制|定められ|とされ|原則|特別条項|厚生労働省|限度時間|時間外労働|休日労働|割増賃金|年次有給休暇/;
var ESTIMATE_LABEL_RE = /仮の(?:数値|数字|計算|例)|架空|説明のための/;
var ESTIMATE_LABEL_BEFORE = 6;
var ESTIMATE_LABEL_AFTER = 1;

/** 1文を分類する：'estimate'（仮の計算例）/ 'ambiguous'（判断できない）/ null（対象外） */
function classifyEstimateSentence_(sentence) {
  var s = sentence;
  ESTIMATE_EXCLUDE_RES.forEach(function (re) { s = s.replace(re, ' '); });
  if (!NUMBER_WITH_UNIT_RE.test(s)) return null;
  var legal = LEGAL_CONTEXT_RE.test(s);
  if (ESTIMATE_STRONG_RE.test(s)) return 'estimate';
  if (ESTIMATE_RESULT_RE.test(s)) return legal ? 'ambiguous' : 'estimate';
  if (ESTIMATE_WEAK_RE.test(s)) return legal ? null : 'ambiguous';
  return null;
}

/**
 * @param {string[]} segments 導入・各H2（見出し＋本文）・まとめなど、注記が届く範囲ごとの文章
 * @return {{unlabeled: string[], ambiguous: string[]}} 注記のない計算例 / 判断できない例（いずれも該当文）
 */
function findEstimateIssues_(segments) {
  var unlabeled = [];
  var ambiguous = [];
  segments.forEach(function (segment) {
    var units = String(segment || '').normalize('NFKC').split(/[。\n]/)
      .map(function (u) { return u.trim(); })
      .filter(function (u) { return u !== ''; });
    units.forEach(function (u, i) {
      var kind = classifyEstimateSentence_(u);
      if (!kind) return;
      var near = units.slice(Math.max(0, i - ESTIMATE_LABEL_BEFORE), i + 1 + ESTIMATE_LABEL_AFTER);
      if (near.some(function (n) { return ESTIMATE_LABEL_RE.test(n); })) return;
      (kind === 'estimate' ? unlabeled : ambiguous).push(u);
    });
  });
  return { unlabeled: unlabeled, ambiguous: ambiguous };
}

/** 文章（1つの範囲）に、注記のない計算例または判断できない例があるか */
function hasUnlabeledEstimate_(text) {
  var r = findEstimateIssues_([text]);
  return r.unlabeled.length > 0 || r.ambiguous.length > 0;
}

/** 注記が届く範囲（タイトル・説明文・導入・各H2・まとめ）に分ける */
function articleEstimateSegments_(article) {
  var segments = [article.title, article.metaDescription, article.introduction];
  article.sections.forEach(function (s) { segments.push(s.heading + '\n' + s.body); });
  segments.push(article.summary);
  return segments;
}

/**
 * 生成文とサンプル記事の間で、空白を除いて n 文字以上連続一致する箇所を探す（丸写し検知）。
 */
function findSampleOverlaps_(text, sampleText, n) {
  if (!sampleText) return [];
  var norm = function (s) { return Array.from(String(s).replace(/\s/g, '')); };
  var sample = norm(sampleText);
  var target = norm(text);
  if (sample.length < n || target.length < n) return [];

  var grams = {};
  for (var i = 0; i + n <= sample.length; i++) grams[sample.slice(i, i + n).join('')] = true;

  var found = [];
  var j = 0;
  while (j + n <= target.length) {
    var gram = target.slice(j, j + n).join('');
    if (grams[gram]) {
      found.push(gram);
      j += n; // 同じ一致箇所を重複して数えない
      if (found.length >= 5) break;
    } else {
      j++;
    }
  }
  return found;
}

/** スプレッドシート確認用の Markdown */
function articleToMarkdown_(article) {
  var out = ['# ' + article.title, '', article.introduction, ''];
  article.sections.forEach(function (s) {
    out.push('## ' + s.heading, '', s.body, '');
  });
  out.push('## ' + SUMMARY_HEADING, '', article.summary);
  return out.join('\n');
}

/** WordPress 投稿用の HTML（タイトルは WordPress のタイトル欄に入れるため本文には含めない） */
function articleToHtml_(article) {
  var out = [paragraphsToHtml_(article.introduction)];
  article.sections.forEach(function (s) {
    out.push('<h2>' + escapeHtml_(s.heading) + '</h2>');
    out.push(paragraphsToHtml_(s.body));
  });
  out.push('<h2>' + SUMMARY_HEADING + '</h2>');
  out.push(paragraphsToHtml_(article.summary));
  return out.join('\n');
}

/** 箇条書き（- / * / ・）と番号付きリスト（1. / 1) / 1．）の行頭 */
var BULLET_RE = /^(?:[-*]\s+|・\s*)/;
var NUMBERED_RE = /^\d{1,2}[.)．）]\s*/;

/**
 * プレーンテキストを段落・箇条書きの HTML に変換する。
 * 段落の直後に空行なしで箇条書きが続く場合も、<p> と <ul>/<ol> に分ける。
 */
function paragraphsToHtml_(text) {
  var blocks = String(text).replace(/\r\n/g, '\n').split(/\n\s*\n/);
  var out = [];
  blocks.forEach(function (block) {
    var lines = block.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l !== ''; });
    var group = null;
    var flush = function () {
      if (!group) return;
      if (group.type === 'p') {
        out.push('<p>' + group.items.map(escapeHtml_).join('<br>') + '</p>');
      } else {
        out.push('<' + group.type + '>\n' + group.items.map(function (it) {
          return '<li>' + escapeHtml_(it) + '</li>';
        }).join('\n') + '\n</' + group.type + '>');
      }
      group = null;
    };
    lines.forEach(function (line) {
      var type = BULLET_RE.test(line) ? 'ul' : NUMBERED_RE.test(line) ? 'ol' : 'p';
      var content = type === 'ul' ? line.replace(BULLET_RE, '') : type === 'ol' ? line.replace(NUMBERED_RE, '') : line;
      if (!group || group.type !== type) {
        flush();
        group = { type: type, items: [] };
      }
      group.items.push(content);
    });
    flush();
  });
  return out.join('\n');
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
