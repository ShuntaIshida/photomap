# Photomap API (Cloud Run)

Node.js 22 + TypeScript + Express 5 のバックエンドです。役割は、Firebase IDトークンの検証、Google Driveの地域フォルダー一覧の提供、写真のアップロード（Driveへの保存とFirestoreへの登録）、サムネイルの代理配信です。

実装していないもの: Firestoreへの地域同期、GPSのない写真の手動位置指定、原本の配信。既存のFirestoreデータは変更しません（`adminOauthStates` を新規に作成し、`photos` はアップロード時に新規ドキュメントを作るだけです）。

## エンドポイント

| 区分 | メソッド・パス | 認証 | 内容 |
| --- | --- | --- | --- |
| 公開 | `GET /health` | なし | ヘルスチェック |
| 公開（stateで保護） | `GET /oauth/google/callback` | 管理者が開始時に発行した1回限りの`state` | Googleからのリダイレクト受け口 |
| 公開 | `GET /regions` | なし | Drive直下フォルダー由来の地域slug一覧（`{regions:[{slug}]}`）。フォルダーIDは返さない |
| 公開 | `GET /photos/:photoId/original` | なし | 全画面ビューア用。JPEGは原本を無加工で、HEICは表示用JPEG（長辺2560px）へ都度変換して返す（変換結果はDriveに保存しない） |
| 公開 | `GET /photos/:photoId/thumbnail` | なし | Firestoreに登録済みの写真のサムネイルJPEGをDriveから代理配信。Driveファイル自体は公開しない |
| ログイン済み | `POST /regions/:slug/photos` | Firebase IDトークン | 写真1枚のアップロード（multipart: `file`=原本のみ。サムネイルはサーバーが生成。旧クライアントの`thumbnail`は無視）。下記「写真アップロード」参照 |
| 管理者 | `POST /admin/drive/oauth/start` | IDトークン＋管理者 | 認可URLを返す（`{authorizationUrl}`） |
| 管理者 | `GET /admin/drive/status` | 同上 | 認可済みか、付与スコープ、`writeAccess`（写真保存に必要な書き込み権限があるか）。トークンは返さない |
| 管理者 | `GET /admin/drive/folders` | 同上 | 地域一覧（フォルダーID付き）と除外されたフォルダー |

- Driveが未認可なら `503 drive_not_authorized`、認可失効なら `503 drive_authorization_invalid`、書き込み権限が無ければ `503 drive_scope_insufficient`、親フォルダーに触れない場合は `502 drive_parent_inaccessible`。エラー形式は `{error:{code,message}}`。
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

## Driveスコープ（写真保存のため `drive` を使用）

`drive.file`は非機密スコープで、「アプリが作成したファイル」と「Google Pickerなどでユーザーがアプリに共有したファイル」にしかアクセスできません（公式: [Drive APIのスコープを選択する](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)）。このため、**ユーザーが手動で作成した`yurihonjo`/`nikaho`フォルダーの列挙も、その中への保存もできません**（親フォルダー経由で列挙するには別のスコープが必要で、既存フォルダーへの書き込みも`drive.file`ではアクセス権が足りない）。

| 案 | スコープ | 区分 | 既存の手動フォルダーへの保存 | 備考 |
| --- | --- | --- | --- | --- |
| A | `drive.file` のみ | 非機密 | 不可（アプリが作成したフォルダーのみ） | 既存フォルダー運用と両立しない |
| B | `drive.file` + Picker | 非機密 | 地域フォルダーごとに管理者がPickerで選択すれば可 | 新しいフォルダーを作るたびに選択が必要で、「フォルダーを作るだけでURLが有効になり、すぐ投稿できる」運用と両立しない。挙動の検証も必要 |
| C | `drive.metadata.readonly` | 制限付き | 不可（読み取りのみ） | **前フェーズの設定。写真保存には不足** |
| D | **`drive`** | 制限付き | **可** | 現在の採用。権限は広い |

**採用: 案D `drive`（+ `openid email`）。** 手動作成済みフォルダーの列挙と書き込みを両立する最小の組み合わせが`drive`になるためです。`drive`はメタデータの読み取りも含むため、`drive.metadata.readonly`は不要になりました。広いスコープなので、次の対策でリスクを抑えています。

- トークンはSecret Managerに保存し、Cloud Runのサービスアカウントだけが読めます（フロントエンドには渡りません）。
- コードが触れるDriveの範囲を限定しています: ①親フォルダー直下のフォルダー一覧、②地域フォルダー直下（と`_thumbnails`）へのファイル作成、③Firestoreに登録済みサムネイルの読み出し。クライアントからはDriveのフォルダーIDもファイルIDも受け取りません。
- OAuthは同意画面の「内部」（Workspace組織内のみ）で運用してください。制限付きスコープは一般公開アプリでは審査が必要ですが、内部アプリなら不要です。**外部かつ「テスト」状態の同意画面では、リフレッシュトークンが7日で失効します。**
- 認可時に`drive`が付与されたことを検証し、同意画面で外された場合はトークンを保存しません（`insufficient_scope`）。

### 再認可が必要です

前フェーズで取得済みのリフレッシュトークンは`drive.metadata.readonly`のみのため、そのままでは写真を保存できません（アップロードは`503 drive_scope_insufficient`になります）。**OAuth同意画面のスコープに`drive`を追加し、管理者が再認可してください**（手順は下記「写真アップロードの設定手順」）。`GET /admin/drive/status` の `writeAccess` が `true` になれば完了です。

## 環境変数

[.env.example](.env.example) を参照。必須: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `OAUTH_REDIRECT_URI`, `DRIVE_OWNER_EMAIL`。`PORT`はCloud Runが注入します。

## 写真アップロード

`POST /regions/:slug/photos`（`Authorization: Bearer <Firebase IDトークン>`、`multipart/form-data`の`file`（原本JPEG/HEIC）のみ）。1リクエスト1枚です。サムネイル（長辺640pxのJPEG）はサーバーが原本から生成します。

サーバーは次の順で処理し、どこかで失敗した場合はDriveに作ったファイルを削除します。

1. IDトークンを検証（無効なら401）。ユーザー単位の回数・同時実行の制限（429）。
2. 原本の**先頭バイトで形式を判定**（JPEG/HEICのみ。クライアント申告のContent-Typeは信用しない）、サイズ（原本20MBまで）を検証。
3. **原本のEXIFからGPS・撮影日時・サイズを読み直す**（クライアントの申告値は使わない）。GPSが無い・不正（範囲外、(0,0)）なら`422 no_gps`で保存しない。撮影日時はEXIFのオフセットがあればそれを使い、無ければ日本時間と仮定して`capturedAtTimeZoneKnown: false`にする。
4. **URLの地域slugからDriveの保存先フォルダーをサーバーが解決**（親フォルダー直下の有効なフォルダーのみ。無ければ`404 region_not_found`）。クライアントが送るフォルダーID等は読み取らない。
5. 写真IDは`<slug>-<原本のSHA-256の先頭32桁>`。同じ写真の再投稿は`409 duplicate_photo`（Firestoreの`create`で原子的に判定）。
6. 原本を地域フォルダー直下に、サムネイル（JPEG）を`<地域フォルダー>/_thumbnails`に保存。どちらも**一般公開の権限は付与しない**。
7. Firestoreの`photos/<id>`に登録（`regionId`、`driveFileId`、`thumbnailDriveFileId`、`latitude`/`longitude`、`capturedAt`、`uploadedAt`（サーバー時刻）、`uploaderUid`（検証済みトークンのuid）、`uploaderName`（トークンの表示名）、`contentHash`、`sizeBytes`など）。メールアドレスは保存しません。

**原本の保存**: Driveに保存するのは1枚につき最大2ファイルだけです。①原本（JPEG/HEICとも無変換。地域フォルダー直下）、②サムネイル（長辺640pxのJPEG。`_thumbnails/<photoId>.jpg`）。表示用の高解像度ファイルはDriveに作りません。

**HEICの処理**: GPS・撮影日時は原本のEXIFから画像デコードとは独立に読みます（exifr。HEICで読めない場合はISOBMFFコンテナからExif項目を直接取り出して再試行）。EXIFの解析失敗は`exif_parse_failed`、位置情報が無い場合は`no_gps`として区別します。画像変換はCloud Run上でlibheif-js（WASM）をワーカースレッドで実行し、sharpでリサイズします（OSパッケージ追加は不要）。同時実行1・待ち行列6（超過は503 `conversion_busy`）・30秒タイムアウト・5,000万画素上限で、ジョブごとにワーカーを終了してメモリを返します。HEICは1件あたり約150〜300MBのメモリを使うため、Cloud Runのメモリは1GiB以上、max-instancesは小さめを推奨します。

**原本の表示**: `GET /photos/:photoId/original`はFirestoreに登録済みの写真だけを写真ID経由で返します（任意のDriveファイルIDは受け付けません）。ログイン不要です。HEICの変換結果は小さなメモリLRU（24MB）と同時リクエストの合流で再変換を抑え、`Cache-Control: public, max-age=31536000, immutable`を付けます。失敗時はJSONエラー（`image_decode_failed`等）を返し、フロントエンドはサムネイルへフォールバックします。既存のJPEG写真は`driveFileId`/`mimeType`だけで原本表示でき、データ移行は不要です。

**配信**: `GET /photos/:photoId/thumbnail`が、Firestoreに登録済みの写真のサムネイルだけをDriveから読んで返します（Driveファイルは公開しない）。任意のDriveファイルIDは受け付けません。ブラウザとの間は`Cache-Control: public, max-age=31536000, immutable`（写真IDが内容ハッシュ由来のため不変）で、Drive APIの利用を抑えます。GitHub Pagesの`<img>`から読めるよう`Cross-Origin-Resource-Policy: cross-origin`を付けています。

**制限**: ユーザーごとに1時間60回まで・同時2件まで（インスタンス内メモリで集計するため、複数インスタンスでは合算されません。Cloud Runの最大インスタンス数も絞ってください）、原本20MB、リクエスト全体約22MBまで（Cloud Runの32MB制限内）。

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

1. **OAuth同意画面**（APIとサービス → OAuth同意画面 / Google Auth Platform）: 対象を「内部」にする（不可なら上記7日失効の制約を理解した上で外部）。データアクセスにスコープ `openid`, `.../auth/userinfo.email`, `.../auth/drive` を追加（写真保存に`drive`が必要。以前の`drive.metadata.readonly`は不要になりました）。
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
  --memory 1Gi --cpu 1 \
  --set-env-vars FIREBASE_PROJECT_ID=photomap-app1,OAUTH_REDIRECT_URI=<上記のURI>,DRIVE_OWNER_EMAIL=<大学アカウント>,GOOGLE_OAUTH_CLIENT_ID=<クライアントID>,ADMIN_UIDS=<管理者UID> \
  --set-secrets GOOGLE_OAUTH_CLIENT_SECRET=photomap-oauth-client-secret:latest
```

既存サービスの再デプロイでは、`--set-env-vars`が既存の環境変数を**置き換える**ため、環境変数を変えない場合は`--set-env-vars`/`--set-secrets`を付けずに`--source backend --memory 1Gi`などだけを指定してください（未指定の設定は引き継がれます）。

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

## 写真アップロードの設定手順（既に認可済みの場合は再認可が必要）

1. **OAuth同意画面でスコープを追加**（Google Cloud Console → APIとサービス → OAuth同意画面 → データアクセス（Google Auth Platform）→ スコープを追加または削除）: `https://www.googleapis.com/auth/drive` を追加して保存。対象が「内部」であることを再確認（外部・テスト状態ではリフレッシュトークンが7日で失効します）。
2. **バックエンドを再デプロイ**（写真アップロードAPIを含む版）。環境変数・シークレットの追加は不要です。サービスアカウントの権限はFirestoreへの書き込み（`Cloud Datastore ユーザー`で足ります）と、Secret Managerの既存の権限のみです。
3. **管理者が再認可**: 「認可の実行手順」と同じ操作で認可URLを取得して開き、**同意画面でGoogle Driveの項目にチェックが入ったまま**許可します（個別に外すと`insufficient_scope`になり保存されません）。新しいリフレッシュトークンが新バージョンとして保存されます。古いバージョンは無効化して構いません。
4. **確認**: `GET /admin/drive/status` の `writeAccess` が `true`、`grantedScopes` に `.../auth/drive` が含まれること。
5. **フロントエンド**: GitHub Actionsの`VITE_API_BASE_URL`（既定はCloud RunのURL）が設定されていれば追加の設定は不要です。ログイン済みユーザーに「写真を追加」ボタンが有効になります。
6. **Firestoreルール**: 変更不要です。`photos`は誰でも読めますがクライアントからは書き込めず、書き込みはCloud Run（Admin SDK）だけが行います。公開されるのは`driveFileId`等のIDで、Driveファイル自体は非公開のため、IDからは閲覧できません。

## 運用上の注意

- Cloud Runの公開エンドポイントに対するDrive API呼び出しは、認証必須＋キャッシュで抑えています。必要なら `--max-instances` やCloud Armorでさらに制限してください。
- リフレッシュトークンは複数インスタンスで共有されます（Secret Manager）。古いバージョンは無効化・破棄して構いません。
- OAuthクライアントシークレットが漏えいした場合は、クライアントのシークレットを再生成し、Secret Managerに新バージョンを登録してください。
