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

OpenAI provider를 사용할 경우 인증 정보를 `.env`에 넣거나 shell에서 export합니다.

```env
OPENAI_API_KEY=...
EASYCODE_MODEL=gpt-5-mini
```

shell 환경 변수는 `.env` 값보다 우선합니다.

## 사용법

일회성 build 작업 실행:

```bash
bun run src/cli.ts build "Fix the failing test" --provider fake
```

plan 작업 실행:

```bash
bun run src/cli.ts plan "Plan the smallest safe change" --provider fake
```

OpenAI 사용:

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai
```

`--logger`를 사용하지 않을 때 모델 텍스트는 생성되는 즉시 stdout으로 스트리밍됩니다.

## 세션

`--session <id>`를 사용하면 대화 기록이 `.easycode/sessions/`에 저장됩니다.

기록을 저장하는 단일 턴 실행:

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai --session demo
```

대화형 세션:

```bash
bun run src/cli.ts build --provider openai --session demo
```

종료하려면 `exit`, `:exit`, `quit`, `:quit` 중 하나를 입력합니다.

## Logger

`--logger`로 구조화된 실행 로그를 활성화합니다.

```bash
bun run src/cli.ts build "帮我看看文件夹下有什么文件" --provider openai --logger
```

`--logger`가 활성화되면 모델 텍스트는 스트리밍되지 않습니다. 최종 결과는 run이 끝난 뒤 출력됩니다. 상태 전환 로그는 강조 표시됩니다.

## 검사

```bash
bun test
bun run eval --provider fake
bun run typecheck
```
