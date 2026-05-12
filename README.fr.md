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

Placez les identifiants du provider dans `.env` ou exportez-les dans le shell. Les variables d'environnement du shell ont priorité sur les valeurs de `.env`.

```env
OPENAI_API_KEY=...
EASYCODE_MODEL=gpt-5-mini

DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-pro
```

## Providers

Les providers sont enregistrés via `src/provider/registry.ts` ; le code de l'agent, du CLI et de l'évaluation crée des providers via ce registre plutôt que par des vérifications codées en dur.

Providers intégrés :

- `fake` : provider local déterministe pour les tests et les évaluations.
- `openai` : provider OpenAI Responses API.
- `deepseek` : provider DeepSeek Chat Completions avec `thinking`, `reasoning_effort: "high"` et `stream: false`.

## Utilisation

```bash
bun run src/cli.ts build "Fix the failing test" --provider fake
bun run src/cli.ts plan "Plan the smallest safe change" --provider fake
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai
bun run src/cli.ts build "我当前有什么可用的skill" --provider deepseek --logger
```

Sans `--logger`, le texte du modèle est diffusé vers stdout au fur et à mesure de sa génération. Avec `--logger`, le texte du modèle est imprimé après la fin de l'exécution pour que les logs structurés ne se mélangent pas avec la réponse.

## Sessions

Utilisez `--session <id>` pour démarrer une session interactive et persister l'historique dans `.easycode/sessions/`. Saisissez les prompts après l'apparition de `> `.

```bash
bun run src/cli.ts build --provider deepseek --session demo
```

Quittez avec `exit`, `:exit`, `quit` ou `:quit`.

## Skills

Les skills sont découverts dans ces répertoires :

- `<project>/.agent/skills`
- `<project>/.easycode/skills`
- `~/.agent/skills`
- `~/.easycode/skills`

Les fichiers de skill sont détectés sans tenir compte de la casse comme `skill.md` / `SKILL.md`. Seuls les noms et descriptions des skills sont chargés dans le contexte initialement ; le contenu complet est chargé via l'outil `skill`.

## Logger

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider deepseek --logger
```

Comportement du logger :

- Les logs de requête réseau et de réponse en erreur sont surlignés en jaune ; `provider.request` et `provider.response` ne contiennent que le body de requête/réponse.
- Les logs de transition d'état sont surlignés en cyan.
- Seuls les véritables événements d'erreur sont écrits sur stderr.
- Les échecs du provider sont remontés dans `provider.output` et renvoyés à l'utilisateur comme texte de résultat final d'échec.

## Vérifications

```bash
bun test
bun run eval --provider fake
bun run typecheck
```
