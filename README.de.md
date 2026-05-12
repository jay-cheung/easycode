# easycode

Ein leichtgewichtiger, specs-getriebener Coding-Agent auf Basis von Bun und TypeScript.

## Übersetzungen

- [English](README.md)
- [中文](README.zh-CN.md)
- [日本語](README.ja.md)
- [한국어](README.ko.md)
- [Français](README.fr.md)

## Einrichtung

```bash
bun install
```

Für den OpenAI provider kannst du die Zugangsdaten in `.env` ablegen oder in der Shell exportieren:

```env
OPENAI_API_KEY=...
EASYCODE_MODEL=gpt-5-mini
```

Shell-Umgebungsvariablen haben Vorrang vor Werten aus `.env`.

## Verwendung

Eine einmalige build-Aufgabe ausführen:

```bash
bun run src/cli.ts build "Fix the failing test" --provider fake
```

Eine plan-Aufgabe ausführen:

```bash
bun run src/cli.ts plan "Plan the smallest safe change" --provider fake
```

OpenAI verwenden:

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai
```

Ohne `--logger` wird Modelltext während der Generierung nach stdout gestreamt.

## Sitzungen

Mit `--session <id>` wird der Gesprächsverlauf unter `.easycode/sessions/` gespeichert.

Ein einzelner Durchlauf mit Persistenz:

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai --session demo
```

Interaktive Sitzung:

```bash
bun run src/cli.ts build --provider openai --session demo
```

Beenden mit `exit`, `:exit`, `quit` oder `:quit`.

## Logger

Strukturierte Ausführungslogs mit `--logger` aktivieren:

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai --logger
```

Wenn `--logger` aktiviert ist, wird Modelltext nicht gestreamt. Das Endergebnis wird nach Abschluss des Runs ausgegeben. Logs zu Zustandsübergängen werden hervorgehoben.

## Prüfungen

```bash
bun test
bun run eval --provider fake
bun run typecheck
```
