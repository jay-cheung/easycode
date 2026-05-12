# easycode

Bun と TypeScript で構築された、仕様駆動の軽量コーディングエージェントです。

## 翻訳

- [English](README.md)
- [中文](README.zh-CN.md)
- [한국어](README.ko.md)
- [Deutsch](README.de.md)
- [Français](README.fr.md)

## セットアップ

```bash
bun install
```

Provider の認証情報は `.env` に置くか、shell で export します。shell の環境変数は `.env` の値より優先されます。

```env
OPENAI_API_KEY=...
EASYCODE_MODEL=gpt-5-mini

DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-pro
```

## Providers

Provider は `src/provider/registry.ts` を通じて登録されます。agent、CLI、eval コードはハードコードされた provider チェックではなく、このレジストリを通じて provider を作成します。

組み込み provider:

- `fake`: テストと eval 用の決定論的ローカル provider。
- `openai`: OpenAI Responses API provider。
- `deepseek`: DeepSeek Chat Completions provider。`thinking`、`reasoning_effort: "high"`、`stream: false` を使用します。

## 使い方

```bash
bun run src/cli.ts build "Fix the failing test" --provider fake
bun run src/cli.ts plan "Plan the smallest safe change" --provider fake
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai
bun run src/cli.ts build "我当前有什么可用的skill" --provider deepseek --logger
```

`--logger` を使わない場合、モデルのテキストは生成されるたびに stdout へストリーミングされます。`--logger` を使う場合、モデルテキストは run 完了後に一度だけ出力され、構造化ログと混ざりません。

## セッション

`--session <id>` は対話型セッションを開始し、会話履歴を `.easycode/sessions/` に保存します。`> ` が表示されてからプロンプトを入力します。

```bash
bun run src/cli.ts build --provider deepseek --session demo
```

終了するには `exit`、`:exit`、`quit`、または `:quit` を入力します。

## Skills

Skill は以下のディレクトリから検出されます：

- `<project>/.agent/skills`
- `<project>/.easycode/skills`
- `~/.agent/skills`
- `~/.easycode/skills`

Skill ファイルは大文字小文字を区別せず `skill.md` / `SKILL.md` として一致します。コンテキストにはデフォルトで skill の名前と説明のみロードされ、完全な内容は `skill` ツールを介してロードされます。

## Logger

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider deepseek --logger
```

Logger の動作:

- ネットワークリクエストとエラー応答ログは黄色で強調表示され、`provider.request` と `provider.response` にはリクエスト/レスポンス body のみが含まれます。
- 状態遷移ログはシアン色で強調表示されます。
- 実際の error イベントのみが stderr に書き込まれます。
- Provider の失敗は `provider.output` に含まれ、最終的な失敗結果としてユーザーに返されます。

## チェック

```bash
bun test
bun run eval --provider fake
bun run typecheck
```
