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

OpenAI provider を使う場合は、認証情報を `.env` に置くか、shell で export します。

```env
OPENAI_API_KEY=...
EASYCODE_MODEL=gpt-5-mini
```

shell の環境変数は `.env` の値より優先されます。

## 使い方

単発の build タスクを実行します。

```bash
bun run src/cli.ts build "Fix the failing test" --provider fake
```

plan タスクを実行します。

```bash
bun run src/cli.ts plan "Plan the smallest safe change" --provider fake
```

OpenAI を使います。

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai
```

`--logger` を使わない場合、モデルのテキストは生成されるたびに stdout へストリーミングされます。

## セッション

`--session <id>` を使うと、会話履歴が `.easycode/sessions/` に保存されます。

履歴を保存する単発実行：

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai --session demo
```

対話型セッション：

```bash
bun run src/cli.ts build --provider openai --session demo
```

終了するには `exit`、`:exit`、`quit`、または `:quit` を入力します。

## Logger

`--logger` で構造化された実行ログを有効にします。

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai --logger
```

`--logger` が有効な場合、モデルのテキストはストリーミングされません。最終結果は run の完了後に出力されます。状態遷移ログは強調表示されます。

## チェック

```bash
bun test
bun run eval --provider fake
bun run typecheck
```
