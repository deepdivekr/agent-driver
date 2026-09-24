# 구독 인증 LLM bridge

Agent Driver는 사용자가 이미 로그인한 모델 클라이언트를 우선 사용한다. OAuth access/refresh token, 이메일, 조직 ID, 인증 저장 파일은 읽거나 복사하지 않는다.

## 최초 연결과 재연결

Phase 50부터 **관제센터 → 연결 및 설정 → AI 연결**에서 구독/API 방식, 공식 로그인, API 키·모델을 상시 관리한다. 저장한 구독 모드는 유료 API로 폴백하지 않으며, 기존 환경변수 동작은 최초 저장 전까지만 유지한다. 예전의 일회성 모델 연결 화면은 기존 검증 도구의 호환 경로다. [저장·적용 범위](control-settings.md).

공식 인증 흐름 참고: [OpenAI authentication](https://learn.chatgpt.com/docs/auth). Codex의 로그인 캐시·토큰 갱신은 공식 클라이언트가 소유한다.

자동 감지는 새 인증을 생략한다는 뜻이 아니다. 같은 실행 환경에 유효한 세션이 있으면 재사용하고, `signed_out` 또는 `expired`이면 loopback 로컬 연결 화면에서 해당 client가 소유한 공식 로그인 흐름을 시작한다.

```text
기존 세션 ready
  → 즉시 재사용

signed_out / expired
  → [브라우저로 연결]
  → 또는 Codex [기기 코드로 연결]
  → auth.openai.com/codex/device + 일회용 코드 표시
  → client 공식 status 명령으로 완료 재확인
```

Agent Driver는 로그인 child process의 bounded 상태만 추적한다. device URL은 정확히 `https://auth.openai.com/codex/device`만 표시하고, 계정 이메일·조직·원문 오류·access/refresh token은 UI나 API로 전달하지 않는다. 연결 화면을 닫거나 만료되면 자신이 시작한 미완료 로그인 process를 중단한다.

현재 검증된 시작 명령은 Codex `login` / `login --device-auth`, Claude Code `auth login --claudeai`, Hermes `portal login`이다. OpenCode는 `auth list --format json`으로 준비 상태를 확인하되 공급자 선택이 필요한 interactive login 명령을 Agent Driver가 추측 실행하지 않는다. 관제센터에 로그인 버튼이 없을 때는 OpenCode의 `/connect` 또는 `opencode auth login`으로 공급자를 먼저 연결한다. Cursor도 확인된 로그인 계약이 없어 버튼을 만들지 않는다.

## 선택 순서

```text
MCP client sampling
  → 같은 OS/PATH의 Codex CLI 구독 로그인
  → Claude Code 구독 로그인
  → OpenCode에 연결된 공급자
  → 명시적으로 설정된 API key fallback
  → unavailable
```

`AGENT_DRIVER_LLM_CLIENT=claude,opencode,api`처럼 최초 저장 전의 호스트 설정에서 순서를 좁힐 수 있다. 기본값은 `mcp,codex,claude,opencode,cursor,api`다. 관제센터에서 저장한 **구독 방식**은 선택한 클라이언트를 우선하고 다른 연결된 구독 클라이언트를 후보로 둔다. API로 자동 전환하지 않는다. API 방식의 구독 대체도 사용자가 별도로 켠 경우에만 동작한다. 각 CLI의 고정된 읽기 전용 status 명령만 실행하며 인증 파일을 직접 열지 않는다. [모델 선택·인계 계약](client-handoff.md).

| client | auth 확인 | 구조화 판단 경로 | 비고 |
|---|---|---|---|
| MCP client | MCP capability handshake | `sampling/createMessage`, tools 없음, context 없음 | 연결된 client가 sampling을 지원할 때 최우선 |
| Codex CLI | `codex login status` | ephemeral, read-only sandbox, output schema | ChatGPT 구독 로그인 사용 |
| Claude Code | `claude auth status` | print/json schema, tools·hooks·MCP 없음, session 저장 없음 | claude.ai 구독 로그인 사용 |
| OpenCode | `opencode auth list --format json` | `run --format json`, 임시 프로젝트의 모든 permission deny | OpenCode에 연결된 API/OAuth 공급자와 선택 모델 사용 |
| Cursor Agent | 현재 검증된 명령 없음 | 미지원 | 설치된 공식 status/login 계약을 확인하기 전에는 추측 실행하지 않음 |
| Hermes | `hermes proxy status` | Agent Driver MCP sampling | proxy OAuth 상태는 진단만 하며 auth store를 읽지 않음 |

native CLI bridge는 Agent Driver가 실제로 실행되는 **같은 OS의 client**만 자동 감지한다.

| Agent Driver 실행 위치 | 자동 선택하는 client | 로그인 저장소 |
|---|---|---|
| Windows | Windows용 Codex·Claude 등 | Windows의 공식 client 저장소 |
| WSL | WSL/Linux용 Codex·Claude 등 | 해당 WSL 배포판의 공식 client 저장소 |
| macOS | macOS용 client | macOS의 공식 client 저장소 |
| Linux | Linux용 client | 해당 Linux 사용자의 공식 client 저장소 |

WSL에서는 Windows PATH가 자동으로 합쳐질 수 있다. Agent Driver는 `/mnt/c/...`의 Windows npm shim을 자동 후보에서 제외하고, Linux PATH와 `~/.local/bin`, `~/.npm-global/bin`, NVM의 Node 설치 경로에서 네이티브 실행 파일을 찾는다. WSL 네이티브 client가 없으면 Windows shim으로 조용히 우회하지 않고 `wsl_native_client_not_found`를 반환한다. 따라서 MCP 서버가 WSL에서만 동작하는 것이 아니라, **MCP 서버를 설치·실행한 환경의 client와 인증을 사용한다**. 다른 환경의 client를 쓰려면 MCP client sampling을 사용하거나 그 환경에도 공식 CLI를 한 번 설치·로그인한다.

ChatGPT 구독으로 로그인한 Codex의 만료 전 token 갱신은 Codex가 직접 수행한다. Agent Driver는 access/refresh token을 읽거나 자체 갱신하지 않고, 공식 client 호출이 재인증 필요 상태를 반환할 때만 로컬 연결 화면에 다시 연결할 방법을 제공한다.

모든 경로는 원문 요청과 code-owned JSON schema만 받고 tool을 주지 않는다. 반환 JSON은 Pack/Swarm의 Zod 계약으로 다시 검증한다. 모델은 실행 권한, 제출 승인, 완료 판정을 만들지 못한다.

OpenCode가 지원하는 공급자 전체를 Agent Driver가 각각 직접 구현한 것은 아니다. OpenCode bridge는 OpenCode의 설정·인증을 재사용한다. 직접 API 연결은 OpenAI, Anthropic, OpenRouter, OpenAI 호환 endpoint 네 종류이며 실제 구조화 probe를 통과해야 관제센터에서 저장된다. OpenCode 문서상 Claude Pro/Max 계정용 비공식 인증 plugin은 약관 문제로 지원 경로에 포함하지 않는다. Claude 구독은 별도의 공식 Claude Code bridge를 사용한다.

## Jev가 없을 때

`TYPESAFE_API_KEY`가 없거나 빈 값이면 오류가 아니다.

```text
Jev: skipped_not_configured
request/state + code-owned candidates
  → subscription LLM structured judgment
  → code schema/policy/freshness validation
  → executor
  → independent readback
```

Jev 키가 있으면 기존 calibrated fast path를 먼저 사용한다. Jev가 낮은 신뢰도·no-match·unavailable을 반환하면 같은 LLM 경로로 넘어간다. 짧지만 반복되는 판단에서 Jev의 속도·정확도 이득이 shadow evaluation으로 확인될 때만 계속 사용한다.

설정된 키가 너무 짧거나 손상된 경우는 조용히 무시하지 않고 `TYPESAFE_CREDENTIAL_INVALID`로 중단한다. 이는 “키가 없음”과 “잘못된 비밀을 설정함”을 구분하기 위해서다.

## 공식 계약 근거

- OpenAI Codex 인증: <https://learn.chatgpt.com/docs/auth>
- Claude Code 인증: <https://docs.anthropic.com/en/docs/claude-code/authentication>
- OpenCode 공급자: <https://opencode.ai/docs/providers>
- OpenCode CLI: <https://opencode.ai/docs/cli>
- Anthropic structured outputs: <https://platform.claude.com/docs/en/build-with-claude/structured-outputs>
- OpenRouter structured outputs: <https://openrouter.ai/docs/guides/features/structured-outputs>
- Cursor Agent CLI 인증: <https://docs.cursor.com/en/cli/reference/authentication>
- Hermes provider/OAuth: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/integrations/providers.md>
- MCP sampling: <https://modelcontextprotocol.io/specification/latest/client/sampling>
- TypeSafe intent routing: <https://docs.typesafe.ai/patterns/intent-routing.md>
