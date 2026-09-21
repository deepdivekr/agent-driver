# Hermes runtime + Telegram human channel

## 역할

실행 구조는 다음 한 줄로 고정한다.

```text
Telegram → Hermes gateway/agent → Agent Driver MCP → owned Agent Computer
```

- **Hermes**: Telegram 대화, 장기 기억, 계획, 반복 작업, 질문과 결과 전달을 담당한다.
- **Agent Driver**: 연결된 source/target, browser/CLI lease, 외부 효과, 승인, 재시도 금지, 독립 readback을 담당한다.
- **TypeSafe/Jev**: `task_request / intervention_response / non_actionable / unknown` 같은 짧은 typed 판단을 빠르게 한다. 불확실하거나 처음 보는 상태는 Hermes의 LLM 또는 사람에게 넘긴다.
- **Telegram**: 새 task를 자연어로 받으며, 질문·인증 대기·승인 UI를 사용자에게 전달한다. Telegram 메시지 자체는 실행 권한이 아니다.

Hermes는 공식 Telegram gateway와 MCP client를 이미 제공하므로 Agent Driver 안에 별도 Telegram Bot API client를 만들지 않는다. 이 방식은 중복 polling, update cursor, retry, 첨부 파일 처리, 사용자 인증 구현을 피한다.

## 설치와 연결

Agent Driver를 빌드하고 로컬 연결을 승인한 뒤 실행한다.

```bash
cd agent-driver
npm ci
npm run build
node dist/cli.js connect
node dist/cli.js hermes configure
node dist/cli.js hermes doctor
hermes mcp test agent-driver
```

`hermes configure`는 `~/.hermes/config.yaml`의 `mcp_servers.agent-driver` 항목만 갱신한다. 기존 서버와 설정을 보존하고 `~/.hermes/.env`는 읽어 변경하지 않는다. 등록되는 서버는 현재 Node와 Agent Driver의 절대 entrypoint를 사용한다. MCP sampling은 끄고, 필요한 도구만 Hermes에 노출하며, form elicitation은 10분으로 설정한다.

Telegram bot 연결은 Hermes 공식 흐름을 사용한다.

```bash
hermes gateway setup
hermes gateway restart
```

Bot token은 명령행 인수, Agent Driver 설정, Task Pack, Git에 넣지 않는다. Hermes의 private profile `.env` 또는 지원되는 secret source에만 둔다. `TELEGRAM_ALLOWED_USERS`를 반드시 설정하고 `*_ALLOW_ALL_USERS`는 사용하지 않는다.

## 사람 개입의 네 종류

| 종류 | 예 | 권한 |
|---|---|---|
| 새 task | “다음 주 도쿄 항공편 찾아줘” | 계획 시작만 가능 |
| clarification/choice | “도쿄로”, “두 번째 후보” | 해당 question ID의 데이터만 보충 |
| authentication | 휴대폰 push 인증 완료 알림 | 로그인 상태를 다시 관측할 계기만 제공 |
| external-write approval | 제출·수정·장바구니 변경 | Hermes MCP elicitation에서 사람이 직접 확인한 현재 snapshot 1회만 승인 |

승인 버튼을 누르면 Agent Driver는 task ID, proposal hash, expiry, single-use 상태를 다시 확인한다. 승인 token은 Hermes나 모델 응답에 노출하지 않는다. 거절은 proposal을 무효화하고 task를 취소한다. UI를 닫은 경우 proposal은 대기 상태로 남고 실행되지 않는다.

## 현재 실환경 상태의 의미

`hermes mcp test agent-driver`가 성공하면 Hermes가 stdio 서버와 도구를 발견했다는 뜻이다. Telegram에서 실제 task가 끝까지 동작했다는 뜻은 아니다. 실제 gateway 검증에는 유효한 새 bot token, 제한된 사용자 ID, Hermes model auth, 연결된 Agent Driver Pack source/target이 필요하다.
