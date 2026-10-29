# Photomap API (Cloud Run)

Node.js 22 + TypeScript + Express 5 のバックエンドです。現段階の役割は **Google Driveの地域フォルダー一覧を安全に取得できる基盤**の提供のみです。

実装していないもの（今回の範囲外）: 写真アップロード、Driveへの書き込み、Firestoreへの地域同期、Cloud Runへのデプロイ。既存のFirestoreデータは変更しません（新規コレクション `adminOauthStates` のみ作成します）。

## エンドポイント

| 区分 | メソッド・パス | 認証 | 内容 |
| --- | --- | --- | --- |
| 公開 | `GET /health` | なし | ヘルスチェック |
| 公開（stateで保護） | `GET /oauth/google/callback` | 管理者が開始時に発行した1回限りの`state` | Googleからのリダイレクト受け口 |
| 公開 | `GET /regions` | なし | Drive直下フォルダー由来の地域slug一覧（`{regions:[{slug}]}`）。フォルダーIDは返さない |
| 管理者 | `POST /admin/drive/oauth/start` | IDトークン＋管理者 | 認可URLを返す（`{authorizationUrl}`） |
| 管理者 | `GET /admin/drive/status` | 同上 | 認可済みか（トークンは返さない） |
| 管理者 | `GET /admin/drive/folders` | 同上 | 地域一覧（フォルダーID付き）と除外されたフォルダー |

- Driveが未認可なら `503 drive_not_authorized`、認可失効なら `503 drive_authorization_invalid`、親フォルダーに触れない場合は `502 drive_parent_inaccessible`。エラー形式は `{error:{code,message}}`。
- フォルダー名がそのままslugです。`^[a-z0-9]+(-[a-z0-9]+)*$`（64文字以内）に合わないフォルダーと同名フォルダーは地域として採用せず、管理者向けAPIの`ignored`に出ます。
- `/regions`は、Webアプリが「地域URLが有効か」を判定するための正本としてログイン不要で公開しています（閉覧はログイン不要のため）。フロントはこの一覧を画面に地域一覧として表示しません。返すのはslugのみです。Drive APIを保護するため、結果は60秒キャッシュし、同時リクエストは1回のDrive呼び出しにまとめます。Driveへの取得に失敗した場合は直近の成功結果を最大24時間返し（地域一覧が空にならない）、失敗直後の10秒は再試行しません。成功結果が一度も無い場合のみエラー（`503`等）を返します。管理者向けの`/admin/drive/folders`は常に最新を取得し、失敗をそのまま返します。フォルダー名をDriveで追加・削除・改名してから反映されるまでは最大60秒程度です。
- 管理者判定は、検証済みIDトークンのカスタムクレーム `admin: true` または環境変数 `ADMIN_UIDS`（UID許可リスト）のみです。メールアドレスは判定に使いません。トークンは失効チェック付きで検証します。

## OAuthの設計

```text
管理者(ブラウザ)        Photomap API                Google              Secret Manager / Firestore
  | POST /admin/drive/oauth/start (Bearer IDトークン)
  |------------------------>| 管理者確認 → state(256bit)+PKCE生成
  |                         |-- state(SHA-256)と紐づくuid・verifierを保存(10分, 1回限り) --> Firestore
  |<-- {authorizationUrl} --|
  |-------- 認可URLへ遷移 ------------------------->| 同意
  |<------ 302 /oauth/google/callback?code&state ---|
  |------------------------>| stateを消費(再利用不可) → 開始uidが今も管理者か再確認
  |                         |-- code+PKCE verifierを交換 -->|
  |                         | IDトークンのemail == DRIVE_OWNER_EMAIL か検証
  |                         |-- リフレッシュトークンを新バージョンとして保存 --> Secret Manager
```

- **コールバックの認証にIDトークンは使いません。** ブラウザのリダイレクトにはAuthorizationヘッダーを付けられず、クロスサイトCookieもSafari等で信頼できないためです。代わりに、管理者のIDトークンで発行したサーバー側の`state`（256bitの乱数、Firestoreに保存、1回限り、10分で失効）をセッション連携の鍵とします。攻撃者は有効な`state`を作れないため、被害者に攻撃者の`code`を送り込むCSRFが成立しません。PKCE(S256)も併用します。
- 認可を行ったGoogleアカウントが `DRIVE_OWNER_EMAIL` と一致し、メール検証済みでなければ保存しません。
- `access_type=offline` と `prompt=consent` でリフレッシュトークンを確実に取得します。アクセストークンはメモリ上でライブラリが自動更新します。
- クライアントシークレットはCloud Runのシークレット参照（環境変数）、リフレッシュトークンはSecret Managerの `DRIVE_REFRESH_TOKEN_SECRET` の最新バージョンから読みます（60秒キャッシュ）。どちらもログ・レスポンスに出しません。ログにはクエリ文字列（`code`/`state`）も含めません。
- CORSは `https://shuntaishida.github.io`（パスなしのオリジン）、`http://localhost:5173`、`http://127.0.0.1:5173` のみ許可します（`CORS_ALLOWED_ORIGINS`で上書き可、`*`は拒否）。

## Driveスコープの調査と推奨

`drive.file`は非機密スコープで、「アプリが作成したファイル」と「Google Pickerなどでユーザーがアプリに共有したファイル」にしかアクセスできません。そのため、**ユーザーが手動で作成した`yurihonjo`/`nikaho`フォルダーを親フォルダー経由で列挙する用途には使えません**（公式: [Drive APIのスコープを選択する](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)）。

| 案 | スコープ | 区分 | 地域フォルダー列挙 | 権限の広さ |
| --- | --- | --- | --- | --- |
| A | `drive.file` のみ | 非機密 | 手動作成フォルダーは不可。アプリ自身が作成したフォルダーなら可 | 最小 |
| B | `drive.file` + Pickerで親フォルダーを選択 | 非機密 | 選択したフォルダー自体にはアクセスできるが、**その直下の手動作成フォルダーまで見える保証はない（要検証）** | 小 |
| C | `drive.metadata.readonly` | 制限付き | 可（名前・IDなどのメタデータ。内容の読み取り・書き込みは不可） | 全ファイルのメタデータ閲覧 |
| D | `drive.readonly` / `drive` | 制限付き | 可 | 内容の読み取り（D-2は書き込み）まで含み過大 |

**推奨（現段階）: 案C `drive.metadata.readonly`（+ `openid email`）。** 要件（手動作成済みフォルダーの列挙）を満たす最小のスコープで、内容の読み取りも書き込みもできません。OAuthは同意画面の「Internal」で運用してください。制限付きスコープは一般公開アプリでは審査・セキュリティ評価が必要になりますが、Workspace組織内のInternalアプリなら不要です。**外部（External）かつ「テスト」状態の同意画面では、リフレッシュトークンが7日で失効します。** プロジェクトが大学のGoogle Workspace組織に属しているか確認してください（属していない場合はInternalを選べません）。

**書き込み（アップロード）フェーズでの方針:** `drive.metadata.readonly`では書き込めません。その時点で次のいずれかを選び、再同意でスコープを追加します。
1. 地域フォルダーはアプリ（`drive.file`）が作成する形に移行し、列挙も`drive.file`のみで行う。案Cのスコープは外せる（最小権限として最善）。
2. 既存の手動フォルダーを使い続け、地域ごとにPickerで選択して`drive.file`の権限を得る（案B。挙動の検証が必要）。

今回は読み取りのみなので、書き込みスコープは要求しません。

## 環境変数

[.env.example](.env.example) を参照。必須: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `OAUTH_REDIRECT_URI`, `DRIVE_OWNER_EMAIL`。`PORT`はCloud Runが注入します。

## 開発・テスト

```sh
cd backend
npm ci
npm run typecheck && npm test && npm run build
```

テストはFirebase・Google・Secret Managerをすべてフェイクに差し替えており、外部通信しません（認証・管理者分離・state/CSRF・アカウント検証・CORS・設定検証・slug変換）。

ローカル起動（実際のFirestore/Secret Managerを使うため、自分のADCが必要）:

```sh
cp .env.example .env   # 値を記入（Gitに含めない）
gcloud auth application-default login
npm run dev
```

## Google Cloudで必要な設定（実行は未実施）

### GUI操作の順序

1. **OAuth同意画面**（APIとサービス → OAuth同意画面 / Google Auth Platform）: 対象を「内部」にする（不可なら上記7日失効の制約を理解した上で外部）。データアクセスにスコープ `openid`, `.../auth/userinfo.email`, `.../auth/drive.metadata.readonly` を追加。
2. **API有効化**: Secret Manager API、Cloud Run Admin API、Cloud Build API、Artifact Registry API（Drive API・Firestore・Identity Toolkitは有効化済み）。
3. **サービスアカウント作成**（IAMと管理 → サービスアカウント）: 例 `photomap-api-sa`。プロジェクトレベルの役割は `Cloud Datastore ユーザー`（stateの保存）と `Firebase Authentication 閲覧者`（失効チェックのユーザー取得）のみ。
4. **Secret Manager**:
   - `photomap-oauth-client-secret` を作成し、OAuthクライアント「Photomap Drive Backend」のシークレットを値として登録（コンソールに直接貼り付け、チャットやGitには載せない）。
   - `photomap-drive-refresh-token` を**バージョンなし**で作成（コンソールで値が必須なら一時的な値を入れ、認可後に最新バージョンが上書きされる）。
   - 権限（各シークレットの権限タブ）: サービスアカウントに、前者へ `Secret Manager シークレットのアクセサー`、後者へ `シークレットのアクセサー` と `シークレット バージョンの追加者`。
5. **Firestore TTL**（Firestore → TTL）: コレクショングループ `adminOauthStates`、フィールド `expiresAt` にTTLポリシーを作成（期限切れstateの自動削除。コード側でも期限を検証します）。
6. **管理者UIDの確認**: Firebase Console → Authentication → ユーザー で自分のUIDをコピーし、`ADMIN_UIDS`に設定（またはカスタムクレーム`admin=true`を付与）。
7. **Cloud Runデプロイ**（確認後に実施）: 下記コマンド例。デプロイ後に、サービスURLを確定してOAuthリダイレクトURIを登録。
8. **OAuthクライアントのリダイレクトURI**（APIとサービス → 認証情報 → Photomap Drive Backend）: 次節のURIを追加。

### OAuthリダイレクトURIの確定方法

`https://<Cloud RunのURL>/oauth/google/callback` です。Cloud Runの決定的URL形式は `https://<サービス名>-<プロジェクト番号>.<リージョン>.run.app` なので、サービス名`photomap-api`・リージョン`asia-northeast1`・プロジェクト番号（FirebaseのMessaging Sender IDと同じ値）から事前に予測できます。予測値: `https://photomap-api-<プロジェクト番号>.asia-northeast1.run.app/oauth/google/callback`。デプロイ後に `gcloud run services describe photomap-api --region asia-northeast1 --format='value(status.url)'` で実URLを確認し、一致することを確かめてから登録してください。違っていた場合は `OAUTH_REDIRECT_URI` を実URLに更新して再デプロイします。`redirect_uri`はGoogle側の登録値と完全一致が必要です。ローカル検証用に `http://localhost:8080/oauth/google/callback` も別エントリとして登録できます。

### デプロイ例（参考・未実行）

```sh
gcloud run deploy photomap-api \
  --source backend --region asia-northeast1 --project photomap-app1 \
  --service-account photomap-api-sa@photomap-app1.iam.gserviceaccount.com \
  --allow-unauthenticated --max-instances 3 \
  --set-env-vars FIREBASE_PROJECT_ID=photomap-app1,OAUTH_REDIRECT_URI=<上記のURI>,DRIVE_OWNER_EMAIL=<大学アカウント>,GOOGLE_OAUTH_CLIENT_ID=<クライアントID>,ADMIN_UIDS=<管理者UID> \
  --set-secrets GOOGLE_OAUTH_CLIENT_SECRET=photomap-oauth-client-secret:latest
```

`--allow-unauthenticated`はHTTPアクセスの公開であり、保護対象APIはアプリ側でFirebase IDトークンを必須にしています。クライアントIDは秘密ではありませんが、シークレットは必ず`--set-secrets`で渡してください。

## 認可の実行手順（デプロイ後・管理者が1回行う）

管理画面は未実装のため、フロントエンドのローカル開発サーバー（`localhost:5173`はCORS許可済み）で管理者アカウントとしてログインし、ブラウザのコンソールで認可URLを取得します。

```js
const { auth } = await import('/src/firebase.ts');
const token = await auth.currentUser.getIdToken();
const res = await fetch('https://<Cloud RunのURL>/admin/drive/oauth/start', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
console.log((await res.json()).authorizationUrl); // このURLをDrive所有者の大学アカウントで開く
```

同意後に「Google Driveの認可が完了しました」と表示されれば完了です。`GET /admin/drive/status` が `authorized: true`、`GET /admin/drive/folders` に `yurihonjo`・`nikaho` が出ることを確認してください。再認可は同じ手順で、新しいバージョンのリフレッシュトークンが保存されます。

## 運用上の注意

- Cloud Runの公開エンドポイントに対するDrive API呼び出しは、認証必須＋キャッシュで抑えています。必要なら `--max-instances` やCloud Armorでさらに制限してください。
- リフレッシュトークンは複数インスタンスで共有されます（Secret Manager）。古いバージョンは無効化・破棄して構いません。
- OAuthクライアントシークレットが漏えいした場合は、クライアントのシークレットを再生成し、Secret Managerに新バージョンを登録してください。
