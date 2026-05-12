# easycode

Bun과 TypeScript로 만든 가벼운 스펙 기반 코딩 에이전트입니다.

## 번역

- [English](README.md)
- [中文](README.zh-CN.md)
- [日本語](README.ja.md)
- [Deutsch](README.de.md)
- [Français](README.fr.md)

## 설정

```bash
bun install
```

Provider 자격 증명을 `.env`에 넣거나 shell에서 export합니다. shell 환경 변수는 `.env` 값보다 우선합니다.

```env
OPENAI_API_KEY=...
EASYCODE_MODEL=gpt-5-mini

DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-pro
```

## Providers

Provider는 `src/provider/registry.ts`를 통해 등록됩니다. agent, CLI, eval 코드는 하드코딩된 provider 확인 대신 이 레지스트리를 통해 provider를 생성합니다.

내장 provider:

- `fake`: 테스트와 eval을 위한 결정론적 로컬 provider.
- `openai`: OpenAI Responses API provider.
- `deepseek`: DeepSeek Chat Completions provider. `thinking`, `reasoning_effort: "high"`, `stream: false`를 사용합니다.

## 사용법

```bash
bun run src/cli.ts build "Fix the failing test" --provider fake
bun run src/cli.ts plan "Plan the smallest safe change" --provider fake
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai
bun run src/cli.ts build "我当前有什么可用的skill" --provider deepseek --logger
```

`--logger`를 사용하지 않을 때 모델 텍스트는 생성되는 즉시 stdout으로 스트리밍됩니다. `--logger`를 사용하면 모델 텍스트가 run 종료 후 한 번에 출력되어 구조화된 로그와 섞이지 않습니다.

## 세션

`--session <id>`는 대화형 세션을 시작하고 대화 기록을 `.easycode/sessions/`에 저장합니다. `> ` 프롬프트가 표시된 뒤 입력하세요.

```bash
bun run src/cli.ts build --provider deepseek --session demo
```

종료하려면 `exit`, `:exit`, `quit`, `:quit` 중 하나를 입력합니다.

## Skills

Skill은 다음 디렉토리에서 발견됩니다:

- `<project>/.agent/skills`
- `<project>/.easycode/skills`
- `~/.agent/skills`
- `~/.easycode/skills`

Skill 파일은 대소문자를 구분하지 않고 `skill.md` / `SKILL.md`로 일치합니다. 컨텍스트에는 기본적으로 skill 이름과 설명만 로드되며, 전체 내용은 `skill` 도구를 통해 로드됩니다.

## Logger

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider deepseek --logger
```

Logger 동작:

- 네트워크 요청과 오류 응답 로그는 노란색으로 강조 표시되며, `provider.request`와 `provider.response`에는 요청/응답 body만 포함됩니다.
- 상태 전환 로그는 청록색으로 강조 표시됩니다.
- 실제 error 이벤트만 stderr에 기록됩니다.
- Provider 실패는 `provider.output`에 포함되며 최종 실패 결과로 사용자에게 반환됩니다.

## 검사

```bash
bun test
bun run eval --provider fake
bun run typecheck
```
