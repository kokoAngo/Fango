# 住まいMBTI診断 (Housing MBTI Finder)

日本の賃貸物件検索システム「REINS」と連携した、住まいMBTIベースの物件推薦Webアプリケーションです。

## 概要

このアプリケーションは、24種類の住まいMBTIタイプから自分に合ったタイプを選択し、そのタイプに基づいてREINSシステムで物件を自動検索します。

## 機能

- 📊 24種類の住まいMBTIタイプから選択
- 🔐 REINSシステムへの自動ログイン
- 🔍 MBTIタイプに基づいた条件での自動物件検索
- 📋 検索結果の一覧表示
- 🎨 日本語対応のモダンなUI

## システム構成

- **バックエンド**: Node.js + Express
- **自動化**: Puppeteer (ブラウザ自動操作)
- **フロントエンド**: HTML + CSS + JavaScript (Vanilla JS)
- **データ**: housing_mbti_presets.json (MBTI条件設定ファイル)

## セットアップ

### 必要要件

- Node.js (v14以上)
- npm または yarn
- REINS システムのアカウント

### インストール手順

1. リポジトリのクローンまたはダウンロード

2. 依存パッケージのインストール:
```bash
npm install
```

3. 環境変数の設定(オプション):
```bash
cp .env.example .env
```

`.env`ファイルを編集して必要に応じて設定を変更:
```env
PORT=3000
HEADLESS=true  # false にするとブラウザの動作が見えます
```

## 使用方法

### サーバーの起動

```bash
npm start
```

開発モード(ファイル変更時に自動再起動):
```bash
npm run dev
```

サーバーが起動したら、ブラウザで以下にアクセス:
```
http://localhost:3000
```

### アプリケーションの使い方

1. **REINSログイン情報の入力**
   - REINSのユーザー名とパスワードを入力

2. **MBTIタイプの選択**
   - 24種類の住まいMBTIタイプから自分に合ったものを選択

3. **検索の実行**
   - 「物件を検索する」ボタンをクリック
   - バックグラウンドでREINSシステムにログインし、条件に基づいて検索を実行

4. **結果の確認**
   - 検索結果ページで推薦物件の一覧を確認

## プロジェクト構造

```
Fango/
├── server.js                          # メインサーバーファイル
├── package.json                       # プロジェクト設定とデ依存関係
├── housing_mbti_presets.json          # MBTI条件設定ファイル
├── .env.example                       # 環境変数のテンプレート
├── services/
│   └── reinsService.js                # REINS自動化サービス
└── public/
    ├── index.html                     # メインページ(MBTI選択)
    └── results.html                   # 検索結果ページ
```

## API エンドポイント

### GET `/api/mbti-types`
全てのMBTIタイプの一覧を取得

**レスポンス**:
```json
[
  {
    "type_id": "neon-fox",
    "display_name_ja": "ネオン節約キツネ"
  },
  ...
]
```

### GET `/api/mbti-types/:typeId`
特定のMBTIタイプの詳細を取得

**レスポンス**:
```json
{
  "type_id": "neon-fox",
  "display_name_ja": "ネオン節約キツネ",
  "basic_conditions": { ... }
}
```

### POST `/api/search`
物件検索を実行

**リクエストボディ**:
```json
{
  "typeId": "neon-fox",
  "username": "reins_username",
  "password": "reins_password"
}
```

**レスポンス**:
```json
{
  "success": true,
  "mbti_type": "ネオン節約キツネ",
  "properties": [
    {
      "id": "...",
      "name": "...",
      "location": "...",
      "rent": "...",
      "area": "...",
      "layout": "...",
      "age": "...",
      "floor": "..."
    },
    ...
  ]
}
```

## 重要な注意事項

### セレクタのカスタマイズが必要

`services/reinsService.js` ファイル内のセレクタ(HTMLエレメントの選択方法)は、実際のREINSシステムのHTML構造に合わせて調整する必要があります。

以下の箇所を確認してください:

1. **ログインフォームのセレクタ** (`login`メソッド)
   ```javascript
   await this.page.type('input[name="username"]', username);
   ```

2. **賃貸物件検索ボタンのセレクタ** (`navigateToRentalSearch`メソッド)

3. **検索条件フォームのセレクタ** (`fillSearchConditions`メソッド)

4. **検索結果のテーブル構造** (`extractProperties`メソッド)

### デバッグ方法

ブラウザの動作を確認したい場合:

1. `.env`ファイルで`HEADLESS=false`に設定
2. サーバーを再起動
3. 検索を実行すると、ブラウザウィンドウが開いて動作が見えます

### エラーハンドリング

- ログインエラー: REINSの認証情報を確認してください
- タイムアウトエラー: `TIMEOUT`の値を増やしてください(reinsService.js)
- セレクタエラー: REINSのHTML構造に合わせてセレクタを修正してください

## カスタマイズ

### MBTIタイプの追加・変更

`housing_mbti_presets.json`ファイルを編集して、MBTIタイプや検索条件をカスタマイズできます。

### UIのカスタマイズ

`public/index.html`と`public/results.html`のCSSセクションを編集して、デザインを変更できます。

## トラブルシューティング

### Puppeteerのインストールエラー

Windowsの場合、ビルドツールが必要な場合があります:
```bash
npm install --global windows-build-tools
```

### REINSへの接続エラー

- ネットワーク接続を確認
- REINSシステムのURLが正しいか確認
- ファイアウォール設定を確認

## ライセンス

MIT

## 免責事項

このアプリケーションはREINSシステムの自動操作を行います。使用する際は:
- REINSの利用規約を確認してください
- 過度なアクセスは避けてください
- 自己責任で使用してください
