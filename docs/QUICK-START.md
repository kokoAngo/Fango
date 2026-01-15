# クイックスタートガイド

## システム起動

### 1. 環境準備

必要な環境変数を `.env` ファイルに設定してください：

```env
OPENAI_API_KEY=your_openai_api_key_here
PORT=3000
```

### 2. サーバー起動

```bash
node server.js
```

起動成功時の表示：
```
============================================================
  Multi-Platform Property Search System
============================================================
  Server running on: http://localhost:3000
  Platforms: ATBB, ITANDI BB, いえらぶBB
============================================================
```

### 3. フロントエンドアクセス

ブラウザで以下のURLにアクセス：
- 検索ページ: http://localhost:3000/
- 結果ページ: http://localhost:3000/results.html

## 使い方

### 基本的な検索

1. **検索ページにアクセス** (http://localhost:3000/)

2. **希望条件を入力**:
   ```
   東京都 渋谷区
   駅から徒歩10分以内
   賃料10万円以内
   2LDK
   南向き
   ペット可
   ```

3. **担当者条件を入力**（任意）:
   ```
   駅近優先
   築浅希望
   1階以外
   日当たり重視
   ```

4. **「物件を検索する」ボタンをクリック**

5. システムが3つのプラットフォームで並列検索を実行します

6. 完了後、結果ページに自動遷移します

### 結果の確認

結果ページには3つのタブが表示されます：
- **ATBB**: ATBB の検索結果
- **ITANDI BB**: ITANDI BB の検索結果
- **いえらぶBB**: いえらぶBB の検索結果

各タブには：
- 検索パラメータ
- 検索結果URL
- 統合PDFへのリンク（準備完了時）

### ダウンロードフォルダ

検索結果は以下の構造で保存されます：

```
D:\Fango\downloads\
  └── search_2026-01-14_143022_東京都渋谷区2LDK/
      ├── search_conditions.json      # 検索条件
      ├── results_summary.json        # 結果サマリー
      ├── atbb/
      │   └── atbb_merged_*.pdf       # ATBB統合PDF
      ├── itandi/
      │   └── itandi_merged_*.pdf     # ITANDI統合PDF
      └── ierube_bb/
          └── ierube_bb_merged_*.pdf  # いえらぶBB統合PDF
```

## API 使用例

### cURLを使った検索

```bash
curl -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "userRequirements": "東京都渋谷区、駅徒歩10分、10万円以内、2LDK",
    "tantousha": "築浅希望、日当たり重視"
  }'
```

### 検索履歴の取得

```bash
curl http://localhost:3000/api/search/history
```

### プラットフォーム状態の確認

```bash
curl http://localhost:3000/api/platforms/status
```

## トラブルシューティング

### サーバーが起動しない

1. **ポートが使用中**:
   ```bash
   # .env ファイルで別のポートを指定
   PORT=3001
   ```

2. **依存関係のインストール**:
   ```bash
   npm install
   ```

### ログインエラー

1. **ATBB ログイン失敗**:
   - 3つのアカウントすべてが使用中の場合
   - 解決策: しばらく待ってから再試行

2. **ITANDI ログイン失敗**:
   - 認証情報を確認
   - `services/itandiService.js` の credentials を確認

3. **いえらぶBB ログイン失敗**:
   - 認証情報を確認
   - `services/ierabuService.js` の credentials を確認

### 検索が途中で止まる

1. **タイムアウト**:
   - Puppeteer のタイムアウト設定を調整
   - `timeout: 60000` を増やす

2. **ページ構造の変更**:
   - プラットフォームのWebサイトが更新された可能性
   - 対応する service ファイルを確認・更新

### ブラウザが表示されない

1. **Chrome パスの確認**:
   - 各 service ファイルの `executablePath` を確認
   - 実際の Chrome インストールパスに合わせる

2. **Headless モードに変更**:
   ```javascript
   headless: true,  // false から true に変更
   ```

## プラットフォーム別の注意事項

### ATBB
- 同時ログイン制限: 1アカウント1セッション
- 並列実行時は3つのアカウントを使用
- 「強制終了」ダイアログが表示される場合あり

### ITANDI BB
- ログインリダイレクト: service.itandi.co.jp → itandi-accounts.com
- 検索条件が多い（100以上のチェックボックス）
- フォーム構造の動的取得が必要

### いえらぶBB
- 市区町村選択: 都道府県ごとに異なるID形式
- チェックボックスが多い（都道府県47個 + 市区町村250個以上）
- ID形式: `shikuchoson-14_101` (都道府県コード_市区町村コード)

## パフォーマンス

- **並列検索時間**: 約30-60秒（3プラットフォーム同時）
- **単独検索時間**: 約10-20秒（1プラットフォーム）
- **AI応答時間**: 約1-3秒（OpenAI API）

## セキュリティベストプラクティス

1. **認証情報の管理**:
   - `.env` ファイルを使用
   - Git にコミットしない（`.gitignore` に追加済み）

2. **ダウンロードフォルダ**:
   - `downloads/` フォルダを `.gitignore` に追加
   - 定期的にクリーンアップ

3. **API キー**:
   - OpenAI API キーは環境変数で管理
   - 共有しない

## サポート

問題が解決しない場合は、以下のログを確認してください：
- サーバーコンソールログ
- ブラウザコンソールログ（開発者ツール）
- `downloads/` フォルダ内の JSON ファイル
