# StreamDeckAI.Updater

完全自動アップデート (確認ダイアログなし)。

## すぐ使う (PowerShell・.NET 不要)

```powershell
cd updater
.\Install-Updater.ps1
```

- 配置: `%LOCALAPPDATA%\StreamDeckAI\Updater\StreamDeckAI-Updater.ps1`
- 起動登録: `HKCU\...\Run\StreamDeckAI.Updater` と Startup の `.bat`
- 初回チェックを実行

リポジトリがまだ無いときは `updater-config.json` の `versionJsonUrl` に `version.json` の URL を書いてください。

## .NET 8 ビルド (任意)

```powershell
dotnet publish StreamDeckAI.Updater.csproj -c Release -r win-x64 --self-contained false -o ..\dist\Updater
```

`StreamDeckAI.Updater.exe --install-runkey` / `--once` / `--daemon`

## プライベート Release 用トークン

リポジトリが private のとき、GitHub Releases API は認証が必要です。
`%LOCALAPPDATA%\StreamDeckAI\updater-config.json` に次を設定してください:

```json
"githubToken": "ghp_xxxxxxxx"
```

- キー名は **`githubToken`** (PAT。最低 `repo` スコープ)
- または環境変数 `STREAMDECKAI_GITHUB_TOKEN`
- 空のままだと private リポジトリでは `releases/latest` が 404 になります
- トークンをリポジトリにコミットしないこと
