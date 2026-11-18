# clasp による Apps Script への配置手順

ローカルの `src/` を、スプレッドシートに紐づいた既存の Apps Script プロジェクトへ clasp で送信する手順です。
clasp はプロジェクト内に開発用として導入済みです（`npm install` で入ります。グローバルへのインストールは不要）。

## 送信されるもの

`src/` 配下の **13ファイル** だけを送信します（`.clasp.json` の `rootDir: "src"` と `.claspignore` で制御）。

| ローカル | Apps Script エディタ上の表示 |
|---|---|
| `src/*.js`（12ファイル） | `ArticleFormatter.gs` など（拡張子は自動で `.gs` になる） |
| `src/appsscript.json` | マニフェスト（エディタの設定で「appsscript.json を表示」にすると見える） |

`test/`・`docs/`・`samples/`・`scripts/`・`node_modules/` は送信されません。

## 秘密情報の扱い

| ファイル | 場所 | 内容 | Git |
|---|---|---|---|
| `.clasp.json` | プロジェクト直下 | スクリプトID と `rootDir` | `.gitignore` で除外 |
| `.clasprc.json` | ユーザーのホームフォルダ | Google のログイン情報（トークン） | プロジェクト外。絶対に共有しない |

スクリプトIDはチャットに貼らず、下記の `--clipboard` で登録してください（画面には先頭と末尾4文字だけ表示されます）。

## 手順

### 0. 事前準備（初回のみ・Google 側の設定）
1. https://script.google.com/home/usersettings を開き、「Google Apps Script API」を **オン** にする（オフのままだと push が失敗する）
2. Apps Script エディタで、初期ファイル `コード.gs`（`myFunction`）の中身が空のままであることを確認する

### 1. Google にログイン
```
! npm run clasp:login
```
ブラウザが開くので、スプレッドシートを作成した Google アカウントで許可します。
確認：`! npm run clasp:whoami`

### 2. スクリプトID の登録（.clasp.json の作成）
Apps Script エディタ「⚙️ プロジェクトの設定 > ID > スクリプト ID」をコピーしてから：
```
! npm run clasp:setup -- --clipboard
```
- 引数で渡す場合：`npm run clasp:setup -- <スクリプトID>`（エディタのURLも可）
- スプレッドシートのURL（`docs.google.com/spreadsheets/...`）は別物のため受け付けません
- 作り直すときは `--force` を付けます

### 3. 送信前チェック（Google 側は変更しない）
```
npm run gas:check
```
ローカルテスト全件と、送信対象が13ファイルであることを確認します。

### 4. 送信
```
npx clasp push
```
マニフェストを上書きするか確認されたら `y` を答えます。送信後、エディタを再読み込みしてファイル構成を確認します。

## 初期コード「myFunction」への影響

- `clasp push` は **リモートのプロジェクト全体をローカルの内容で置き換えます**。ローカルにない `コード.gs`（`myFunction`）は削除されます
- 本システムは `myFunction` を使っておらず、同名の関数もないため、削除しても動作に影響はありません（テストで確認済み）
- 削除して困るのは、`コード.gs` に手で書き足したコードや、`myFunction` を対象にしたトリガーを作っていた場合だけです。手順0で確認してください
- `appsscript.json` も置き換わり、権限が「現在のスプレッドシート・外部への接続・メニュー表示」の3つに絞られます。初めてメニューを実行したときに承認画面が出ます

## GAS 側のファイル構成で確認済みのこと（`test/gas-deploy-readiness.test.js`）

- GAS は全ファイルが1つのグローバル空間を共有し、読み込み順は保証されない → どの順番で読み込んでも動く（各ファイルを単独で読み込める）
- ファイルをまたいだ同名の関数・変数がない（GAS では後から読まれた方が黙って上書きする）
- `require` / `import` / `export` を使っていない
- メニューから呼ぶ関数（`onOpen`、`menu*` の10個）は末尾に `_` を付けない公開関数。それ以外の内部関数は末尾 `_` で、エディタの実行候補やメニューから直接呼べない

## うまくいかないとき

| 表示 | 対処 |
|---|---|
| `User has not enabled the Apps Script API` | 手順0の設定をオンにし、数分待って再実行 |
| `Could not find script` / 権限エラー | `clasp:whoami` のアカウントがスプレッドシートの所有者か確認。スクリプトIDを `--force` で登録し直す |
| `Not logged in` | 手順1をやり直す |
| メニュー「記事生成」が出ない | スプレッドシートを再読み込み。エディタに `Menu.gs` があるか確認 |
