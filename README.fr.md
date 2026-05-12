# easycode

Un agent de codage léger, piloté par des specs, construit avec Bun et TypeScript.

## Traductions

- [English](README.md)
- [中文](README.zh-CN.md)
- [日本語](README.ja.md)
- [한국어](README.ko.md)
- [Deutsch](README.de.md)

## Installation

```bash
bun install
```

Pour utiliser le provider OpenAI, placez les identifiants dans `.env` ou exportez-les dans le shell :

```env
OPENAI_API_KEY=...
EASYCODE_MODEL=gpt-5-mini
```

Les variables d'environnement du shell ont priorité sur les valeurs de `.env`.

## Utilisation

Exécuter une tâche build ponctuelle :

```bash
bun run src/cli.ts build "Fix the failing test" --provider fake
```

Exécuter une tâche plan :

```bash
bun run src/cli.ts plan "Plan the smallest safe change" --provider fake
```

Utiliser OpenAI :

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai
```

Sans `--logger`, le texte du modèle est diffusé vers stdout au fur et à mesure de sa génération.

## Sessions

Utilisez `--session <id>` pour persister l'historique de conversation dans `.easycode/sessions/`.

Un tour unique avec persistance :

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai --session demo
```

Session interactive :

```bash
bun run src/cli.ts build --provider openai --session demo
```

Quittez avec `exit`, `:exit`, `quit` ou `:quit`.

## Logger

Activez les logs d'exécution structurés avec `--logger` :

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai --logger
```

Quand `--logger` est activé, le texte du modèle n'est pas diffusé en streaming. Le résultat final est imprimé après la fin du run. Les logs de transition d'état sont mis en évidence.

## Vérifications

```bash
bun test
bun run eval --provider fake
bun run typecheck
```
