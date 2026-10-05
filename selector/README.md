# StreamDeckAI.Selector

Stream Deck に出す開発中アプリを選ぶ小さな WinForms (.NET 8) アプリ。日本語 UI。

## ビルド (Windows + .NET 8 SDK)

```powershell
cd selector
.\build.ps1
```

または:

```powershell
dotnet publish StreamDeckAI.Selector.csproj -c Release -r win-x64 --self-contained false -o ..\dist\Selector
Copy-Item -Recurse Defaults ..\dist\Selector\Defaults
```

## 動作

1. `%LOCALAPPDATA%\StreamDeckAI\apps.json` を読み込み (無ければ Defaults)
2. 「カタログを再取得」で `wood-shop/grokAppStore` の `AppCatalog/*/manifest.json` を取得し、`streamdeck` 付きだけマージ
3. 「保存してプラグインへ反映」で apps.json 保存 + `POST http://127.0.0.1:17890/apps`

## 注意

現行の AppCatalog エントリにはまだ `streamdeck` / `id` が無いため、当面は同梱 Defaults (claude-code / codex / grok-bot) が使われます。カタログ側に拡張フィールドが載れば自動で増えます。
