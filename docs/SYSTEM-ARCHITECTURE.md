# マルチプラットフォーム物件検索システム アーキテクチャ

## システム概要

このシステムは、3つの日本不動産プラットフォーム（ATBB、ITANDI BB、いえらぶBB）を横断して物件検索を行うバックエンドシステムです。

## システム構成

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend (React)                      │
│              public/index.html, results.html             │
└────────────────────┬────────────────────────────────────┘
                     │ HTTP/JSON
┌────────────────────▼────────────────────────────────────┐
│              Backend Server (Node.js/Express)            │
│                    server.js                             │
├──────────────────────────────────────────────────────────┤
│  API Endpoints:                                          │
│  - POST /api/search          (マルチプラットフォーム検索)   │
│  - POST /api/search/atbb     (ATBB単独検索)             │
│  - POST /api/search/itandi   (ITANDI単独検索)           │
│  - POST /api/search/ierube   (いえらぶBB単独検索)        │
│  - GET  /api/search/history  (検索履歴取得)              │
│  - GET  /api/platforms/status (プラットフォーム状態)      │
└───┬──────────────┬──────────────┬──────────────┬────────┘
    │              │              │              │
┌───▼────────┐ ┌──▼─────────┐ ┌─▼──────────┐ ┌─▼──────────────┐
│  ATBB      │ │  ITANDI    │ │ いえらぶBB  │ │ Search         │
│  Service   │ │  Service   │ │  Service   │ │ Coordinator    │
└───┬────────┘ └──┬─────────┘ └─┬──────────┘ └─┬──────────────┘
    │              │              │              │
┌───▼──────────────▼──────────────▼──────────────▼────────┐
│              AI Requirements Parser (OpenAI)             │
│  - ユーザー条件の理解                                      │
│  - プラットフォーム固有フォーマットへの変換                │
│  - 地域・条件の自動選択                                    │
└──────────────────────────────────────────────────────────┘
    │              │              │
┌───▼────────┐ ┌──▼─────────┐ ┌─▼──────────┐
│  ATBB      │ │  ITANDI BB │ │ いえらぶBB  │
│  Website   │ │  Website   │ │  Website   │
└────────────┘ └────────────┘ └────────────┘
```

## コア機能

### 1. マルチプラットフォーム検索コーディネーター

**ファイル**: `services/searchCoordinator.js`

**役割**:
- 検索セッションの管理
- フォルダ構造の作成
- PDF結果の管理と統合
- 検索履歴の保存

**フォルダ構造**:
```
downloads/
  └── search_2026-01-14_渋谷_2LDK/
      ├── search_conditions.json
      ├── results_summary.json
      ├── atbb/
      │   ├── property_1.pdf
      │   ├── property_2.pdf
      │   └── atbb_merged_*.pdf
      ├── itandi/
      │   ├── property_1.pdf
      │   └── itandi_merged_*.pdf
      └── ierube_bb/
          ├── property_1.pdf
          └── ierube_bb_merged_*.pdf
```

### 2. プラットフォーム固有サービス

#### 2.1 ATBB Service (`services/atbbService.js`)

**プラットフォーム情報**:
- URL: https://atbb.athome.jp/
- 検索URL: https://members.athome.jp/portal
- アカウント: 3つの予備アカウント

**検索フロー**:
1. ログイン (members.athome.jp)
2. ポータルから「流通物件検索」を開く
3. 物件種目選択（賃貸居住用等）
4. 所在地検索（都道府県 → 市区郡 → 市区町村）
5. 検索条件入力
6. 検索実行

**主要機能**:
- `login()`: 3つのアカウントでログイン試行
- `openSearchPage()`: 流通物件検索ページを開く
- `getSearchOptions()`: 利用可能な検索オプション取得
- `aiSelectConditions()`: AI による条件選択
- `selectLocationSearch()`: 所在地選択
- `selectCity()`: 市区町村選択

#### 2.2 ITANDI Service (`services/itandiService.js`)

**プラットフォーム情報**:
- URL: https://service.itandi.co.jp/
- 検索URL: https://itandibb.com/rent_rooms/list
- アカウント: info@fun-t.jp

**検索フロー**:
1. ログイン (service.itandi.co.jp → itandi-accounts.com)
2. 検索ページへ移動
3. フォーム構造取得
4. AI による条件翻訳
5. フォーム入力（賃料、間取り、建物種類等）
6. 所在地で絞り込み
7. 検索実行

**主要フィールド**:
- 賃料: `rent:gteq`, `rent:lteq`
- 間取り: `room_layout:in` (1R, 1K, 1DK, 1LDK, 2LDK等)
- 建物種類: `building_detail_type:in` (mansion, apartment等)
- 取引態様: `offer_deal_type:in` (lender, placeholder等)

#### 2.3 いえらぶBB Service (`services/ierabuService.js`)

**プラットフォーム情報**:
- URL: https://bb.ielove.jp/
- 検索URL: https://bb.ielove.jp/ielovebb/rent/searchmenu/
- アカウント: goto@fun-t.jp

**検索フロー**:
1. ログイン (bb.ielove.jp)
2. 検索メニューページへ移動
3. 都道府県選択（47都道府県）
4. 市区町村選択（都道府県別に250個程度）
5. 検索実行

**主要フィールド**:
- 都道府県: `todofuken[]` (01-47)
- 市区町村: `shikuchoson[]` (形式: 14_101 = 神奈川県_横浜市鶴見区)

### 3. AI 要件パーサー

**使用モデル**: GPT-4o-mini

**機能**:
1. ユーザーの自然言語希望条件を理解
2. 各プラットフォームの検索パラメータに変換
3. 地域・条件の自動選択
4. 選択理由の提供

**入力例**:
```
東京都渋谷区
駅から徒歩10分以内
賃料10万円以内
2LDK
南向き
```

**出力例（ITANDI用）**:
```json
{
  "prefecture": "東京都",
  "city": "渋谷区",
  "station": "渋谷",
  "walkMinutes": 10,
  "rentMin": null,
  "rentMax": 100000,
  "layouts": ["2LDK"],
  "buildingTypes": ["mansion", "apartment"],
  "equipments": [],
  "reasoning": "渋谷区の2LDK、10万円以内の物件を検索"
}
```

## API エンドポイント

### POST /api/search

マルチプラットフォーム検索（並列実行）

**リクエスト**:
```json
{
  "userRequirements": "東京都渋谷区、駅徒歩10分、10万円以内、2LDK",
  "tantousha": "築浅希望、日当たり重視"
}
```

**レスポンス**:
```json
{
  "success": true,
  "user_requirements": "...",
  "tantousha_requirements": "...",
  "results": {
    "atbb": { "success": true, "message": "...", "resultUrl": "..." },
    "itandi": { "success": true, "message": "...", "resultUrl": "..." },
    "ierube_bb": { "success": true, "message": "...", "resultUrl": "..." }
  },
  "session": {
    "sessionPath": "D:/Fango/downloads/search_2026-01-14_...",
    "sessionName": "search_2026-01-14_...",
    "folders": {
      "atbb": "...",
      "itandi": "...",
      "ierube_bb": "..."
    },
    "mergedPdfs": {
      "atbb": "D:/Fango/downloads/.../atbb/atbb_merged_*.pdf",
      "itandi": "...",
      "ierube_bb": "..."
    }
  },
  "summary": {
    "total_platforms": 3,
    "successful_platforms": 3,
    "failed_platforms": 0
  }
}
```

### POST /api/search/atbb

ATBB単独検索

### POST /api/search/itandi

ITANDI BB単独検索

### POST /api/search/ierube

いえらぶBB単独検索

### GET /api/search/history

検索履歴取得

**レスポンス**:
```json
{
  "success": true,
  "history": [
    {
      "sessionName": "search_2026-01-14_...",
      "created": "2026-01-14T...",
      "userRequirements": "...",
      "platforms": {
        "atbb": { "success": true, "mergedPdf": "...", "url": "..." },
        "itandi": { "success": true, "mergedPdf": "...", "url": "..." },
        "ierube_bb": { "success": true, "mergedPdf": "...", "url": "..." }
      }
    }
  ],
  "count": 1
}
```

### GET /api/platforms/status

プラットフォーム状態確認

## 技術スタック

- **Backend**: Node.js, Express
- **Browser Automation**: Puppeteer
- **AI**: OpenAI GPT-4o-mini
- **PDF Processing**: PDFKit (pdf-lib への移行予定)
- **Database**: ファイルシステムベース (将来的にはMongoDBへ移行)

## エラーハンドリング

各プラットフォームの検索は独立して実行され、1つが失敗しても他のプラットフォームの検索は継続されます。

**エラー時のレスポンス**:
```json
{
  "success": false,
  "platform": "ATBB",
  "error": "Login failed: timeout"
}
```

## セキュリティ

- 認証情報は環境変数で管理（`.env`）
- セッション情報は `downloads/` フォルダに保存（`.gitignore`で除外）
- パスワードはハードコードされていない

## 今後の拡張予定

1. **PDF実装の完成**: 実際のPDFダウンロードと統合
2. **データベース統合**: MongoDB による検索履歴管理
3. **WebSocketサポート**: リアルタイム検索進捗通知
4. **キャッシング**: 頻繁に検索される地域のキャッシュ
5. **テストカバレッジ**: 各サービスのユニットテスト
6. **ドキュメント生成**: 検索結果レポートの自動生成
