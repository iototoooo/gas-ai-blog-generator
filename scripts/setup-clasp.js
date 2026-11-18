#!/usr/bin/env node
/**
 * clasp 用のローカル設定ファイル .clasp.json を作成する。
 *
 * - スクリプトIDは引数または Windows のクリップボードから受け取り、画面には一部だけ表示する
 * - .clasp.json は .gitignore で除外されていることを確認してから書き込む
 * - Google には一切接続しない（ファイルを書くだけ）
 *
 * 使い方：
 *   npm run clasp:setup -- --clipboard          クリップボードのスクリプトIDを使う（Windows）
 *   npm run clasp:setup -- <スクリプトID または エディタのURL>
 *   既存の .clasp.json を置き換える場合は --force を付ける
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLASP_FILE = '.clasp.json';

/** スクリプトID、または https://script.google.com/.../projects/<ID>/edit 形式のURLからIDを取り出す */
function extractScriptId(input) {
  const text = String(input || '').trim();
  const fromUrl = text.match(/\/projects\/([A-Za-z0-9_-]+)/) || text.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (/^https?:\/\//.test(text)) {
    if (!/^https:\/\/script\.google\.com\//.test(text) || !fromUrl) {
      throw new Error('Apps Script エディタのURL（https://script.google.com/...）ではありません。スプレッドシートのURLではなく、スクリプトIDを指定してください。');
    }
    return validateScriptId(fromUrl[1]);
  }
  return validateScriptId(text);
}

function validateScriptId(id) {
  if (!/^[A-Za-z0-9_-]{30,120}$/.test(id)) {
    throw new Error('スクリプトIDの形式ではありません（英数字・-・_ のみ、30文字以上）。Apps Script の「プロジェクトの設定 > ID」の値を指定してください。');
  }
  return id;
}

/** 画面表示用に先頭と末尾だけ残す */
function maskId(id) {
  return id.slice(0, 4) + '…' + id.slice(-4) + '（' + id.length + '文字）';
}

function buildClaspConfig(scriptId) {
  return { scriptId: scriptId, rootDir: 'src' };
}

function readClipboard() {
  if (process.platform !== 'win32') throw new Error('--clipboard は Windows のみ対応です。スクリプトIDを引数で指定してください。');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
    { encoding: 'utf8', windowsHide: true });
}

function isGitIgnored(root, file) {
  try {
    execFileSync('git', ['check-ignore', '-q', file], { cwd: root, stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function setupClasp(options) {
  const root = options.root || ROOT;
  const target = path.join(root, CLASP_FILE);
  if (fs.existsSync(target) && !options.force) {
    throw new Error(CLASP_FILE + ' はすでに存在します。置き換える場合は --force を付けてください。');
  }
  if (!options.skipGitCheck && !isGitIgnored(root, CLASP_FILE)) {
    throw new Error(CLASP_FILE + ' が .gitignore で除外されていないため、作成を中止しました。');
  }
  const scriptId = extractScriptId(options.input);
  fs.writeFileSync(target, JSON.stringify(buildClaspConfig(scriptId), null, 2) + '\n', 'utf8');
  return { file: target, maskedId: maskId(scriptId) };
}

function main(argv) {
  const args = argv.slice(2);
  const force = args.includes('--force');
  const useClipboard = args.includes('--clipboard');
  const positional = args.filter((a) => !a.startsWith('--'));
  if (!useClipboard && positional.length === 0) {
    console.error('使い方: npm run clasp:setup -- --clipboard   または   npm run clasp:setup -- <スクリプトID>');
    process.exit(1);
  }
  try {
    const input = useClipboard ? readClipboard() : positional[0];
    const result = setupClasp({ input: input, force: force });
    console.log('.clasp.json を作成しました（Git管理外）。スクリプトID: ' + result.maskedId + '、rootDir: src');
    console.log('Google にはまだ接続していません。次は npm run clasp:status で送信対象を確認してください。');
  } catch (e) {
    console.error('エラー: ' + e.message);
    process.exit(1);
  }
}

if (require.main === module) main(process.argv);

module.exports = { extractScriptId, validateScriptId, maskId, buildClaspConfig, setupClasp };
