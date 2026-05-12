# easycode

Ein leichtgewichtiger, specs-getriebener Coding-Agent auf Basis von Bun und TypeScript.

## Ubersetzungen

- [English](README.md)
- [中文](README.zh-CN.md)
- [日本語](README.ja.md)
- [한국어](README.ko.md)
- [Français](README.fr.md)

## Einrichtung

```bash
bun install
```

Provider-Zugangsdaten konnen in `.env` abgelegt oder in der Shell exportiert werden. Shell-Umgebungsvariablen haben Vorrang vor `.env`-Werten.

```env
OPENAI_API_KEY=...
EASYCODE_MODEL=gpt-5-mini

DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-pro
```

## Providers

Provider werden uber `src/provider/registry.ts` registriert. Agent, CLI und Eval-Code erstellen Provider uber diese Registry statt uber hartcodierte Provider-Prufungen.

Eingebaute Provider:

- `fake`: deterministischer lokaler Provider fur Tests und Evals.
- `openai`: OpenAI Responses API Provider.
- `deepseek`: DeepSeek Chat Completions Provider mit `thinking`, `reasoning_effort: "high"` und `stream: false`.

## Verwendung

```bash
bun run src/cli.ts build "Fix the failing test" --provider fake
bun run src/cli.ts plan "Plan the smallest safe change" --provider fake
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai
bun run src/cli.ts build "我当前有什么可用的skill" --provider deepseek --logger
```

Ohne `--logger` wird Modelltext wahrend der Generierung nach stdout gestreamt. Mit `--logger` wird Modelltext erst nach Abschluss des Runs ausgegeben, damit strukturierte Logs sich nicht mit der Antwort vermischen.

## Sitzungen

Mit `--session <id>` wird eine interaktive Sitzung gestartet und der Gesprachsverlauf unter `.easycode/sessions/` gespeichert. Geben Sie Prompts erst nach dem `> ` ein.

```bash
bun run src/cli.ts build --provider deepseek --session demo
```

Beenden mit `exit`, `:exit`, `quit` oder `:quit`.

## Skills

Skills werden aus diesen Verzeichnissen erkannt:

- `<project>/.agent/skills`
- `<project>/.easycode/skills`
- `~/.agent/skills`
- `~/.easycode/skills`

Skill-Dateien werden ohne Berucksichtigung der Gross-/Kleinschreibung als `skill.md` / `SKILL.md` erkannt. Zunachst werden nur Skill-Namen und Beschreibungen in den Kontext geladen; der vollstandige Inhalt wird uber das Tool `skill` geladen.

## Logger

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider deepseek --logger
```

Logger-Verhalten:

- Netzwerk-Request-Logs und Fehler-Response-Logs werden gelb hervorgehoben. `provider.request` und `provider.response` enthalten nur den Request-/Response-Body.
- Zustandsubergangs-Logs werden cyan hervorgehoben.
- Nur echte Error-Events werden nach stderr geschrieben.
- Provider-Fehler erscheinen in `provider.output` und werden dem Benutzer als finaler failed-result Text zuruckgegeben.

## Prufungen

```bash
bun test
bun run eval --provider fake
bun run typecheck
```
