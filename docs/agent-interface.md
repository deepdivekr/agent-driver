# Agent interface — Phase 19

## 실제 지원과 남은 범위

CLI와 stdio MCP는 같은 RuntimeApi를 사용한다. 원문19개와 `runtime_task_intake`, Phase19의 `runtime_terminal_sessions_list`/`runtime_terminal_history`/`runtime_terminal_output_read`/`runtime_terminal_handoff`로 총24개 이름을 제공한다. 조회/인계의 페이지·검증·private artifact 계약은 [별도 안내](terminal-handoff.md)를 따른다. 원문의 “15종” 문구 대신 명명된 전체 목록을 기준으로 했다.

사용 가능: health, capabilities list/describe, task start/status/cancel/resume, recovery status/prepare, artifacts list(미지원/빈 목록 명시), events read/ack, intake. resume/prepare는 안전하게 준비된 미전송 작업에만 적용한다.

terminal start/status/submit_prompt/resume/interrupt는 명시적으로 설정된 Linux Claude 구조화 세션에서 동작한다. 파일 도구는 아직 차단되어 세션 통신만 시험할 수 있다. [CLI adapter 근거표](cli-adapter-matrix.md)를 먼저 확인한다. 명시적 `NOT_IMPLEMENTED`: browser session open/status. `verify`, `soak`, `ops` CLI 역시 미구현이며 help에 표시한다. 이 목록을 MCP 완전 구현이나 공식 릴리즈 완료라고 부르지 않는다.

실제 외부 write capability는 `fixture.draft.save` 한 개이며 **host 설정에 environment=fixture가 있어야** 보인다. production 기본값에는 실행 capability가 없다. terminal 설정 시 `coding.session` 실험적 통신 capability가 추가된다. Linux 프로세스 복구와 Windows/재부팅 복구를 구분한다.

## 사용 흐름

Ubuntu/WSL Bash, 저장소 디렉터리에서 실행한다. 아래의 첫 터미널은 합성 앱을 제공하므로 계속 켜 둔다. lab 디렉터리는 새 경로여야 하며 기존 설정/기록을 덮어쓰지 않는다.

```bash
cd agent-driver
npm ci
npx playwright install chromium
npm run build
node dist/cli.js fixture serve --data-dir .runtime/lab-01
```

두 번째 터미널에서도 같은 저장소로 이동한다.

```bash
cd agent-driver
node dist/cli.js doctor --config .runtime/lab-01/host.json --json
node dist/cli.js capabilities list --config .runtime/lab-01/host.json --json
node dist/cli.js intake --config .runtime/lab-01/host.json --prompt '이름 봄, 메모 점심 회의 초안을 저장해'
node dist/cli.js mcp --config .runtime/lab-01/host.json
```

마지막 명령은 MCP 클라이언트가 시작할 프로세스다. 일반 대화형 프롬프트를 읽지 않으며 JSON-RPC만 처리한다. 사용 중인 agent의 MCP 설정에 실제 Node executable, 저장소의 절대 `dist/cli.js` 경로, `mcp --config` 및 절대 host.json 경로를 지정한다. 제품별 설정 키를 추정해 제시하지 않는다. 이번 증거는 공식 SDK client 연결이며 OpenClaw/Hermes 실제품 설정 검증을 대체하지 않는다.

원문 한 줄만 전달하면 `NEEDS_EXTRACTION`과 좁은 인수 질문을 돌려준다. 호출 agent가 자신의 모델로 추출한 `name`, `note` 값과 UTF-16 `[start,end)` 원문 범위를 proposal로 전달하면 범위를 검증한다. 결과는 항상 `dispatch_allowed=false`; 범위 일치는 사용자 의도의 의미적 정답을 보장하지 않는다. 창작/다중 작업/모호한 지시/빠진 값은 호출 agent가 확인하며 지원 부분만 임의 실행하지 않는다. 사용자는 state/question을 작성하지 않는다. Jev/Luna API 연결·모델 sampling은 현재 제품 경로에 없다.

실행은 기존 host 위임 안에서 별도 `runtime_task_start` 요청을 사용한다:

```json
{"request_id":"draft-001","capability":"fixture.draft.save","account_ref":"account-a","input":{"name":"봄","note":"점심 회의"},"deadline_ms":30000}
```

동일 요청 ID와 같은 정규화 입력은 기존 task 결과를 반환한다. 입력·deadline·계정·host 설정이 바뀌면 충돌 오류다. 새 ID로 재시도하는 것은 중복 방지 우회이므로 응답 유실 시 기존 ID를 유지하고 상태를 조회한다. 로컬 dedup은 외부 시스템의 exactly-once 보장이 아니다.

## 지속성·소유권·보안

- 요청 수락은 task와 submission을 같은 SQLite WAL/FULL transaction으로 기록한다. source DB v1/v2/v3는 기존 데이터·intent·이벤트를 보존하며 v4로 migration한다. v4는 terminal host/session/turn을 추가한다. v2의 시작 신원이 없는 worker는 `legacy_unknown`, 같은 boot의 monotonic 접수 시점이 없는 요청은 자동 실행 차단이다. 구버전 실행 파일의 v4 DB 호환성은 보장하지 않는다. 업그레이드 백업/복원 검증은 출시 전 별도 gate다.
- gateway는 먼저 독립 감독자를 확보한 뒤 durable queue에 접수한다. 감독자가 단일 실행 예약을 발급하고 고정 worker를 shell 없이 시작한다. stdout/stderr를 연결하지 않고 OS 입력/창 활성화를 사용하지 않는다. Linux 부팅 ID·PID·kernel 시작 tick 및 nonce/generation으로 신원을 확인하며 PID만으로 종료/lease 회수하지 않는다.
- 동일 profile의 작업은 lease로 직렬화하며 context가 닫힌 뒤에만 다음 worker가 사용한다. 프로젝트의 수락 대기/실행 task 수는 16개로 제한하고 deadline은 1~120초다. 이는 장기 운영 supervisor·crash-loop·global resource budget 전체를 대체하지 않는다.
- worker 사망과 profile 비점유를 확인한 미전송 작업만 최대 3회/지수 backoff로 재개한다. 하나라도 intent가 있으면 identity/record GET만 수행하고 불일치·UNKNOWN은 중단한다. 감독자 자체의 사망은 다음 명시적 start/접수로 복구하며 OS watchdog 자동 복구는 아직 없다. 자세한 정책·중지법은 [감독/복구 계약](supervisor-recovery.md)을 따른다.
- caller/project/profile/account는 host 파일에서 고정한다. MCP 입력으로 바꾸거나 승인 발급할 수 없다. scope 검사에는 읽기/취소/이벤트도 포함한다. 동일 OS 사용자가 설정·DB를 바꿀 수 있는 권한은 보안 경계 밖이다.
- 입력/파일 크기 및 request schema를 제한한다. DB는 POSIX 0600, 새 데이터 디렉터리는 0700. Windows ACL 강화를 검증했다고 주장하지 않는다. worker에는 필요한 환경변수만 넘기며 모델 API 키와 NODE_OPTIONS를 상속하지 않는다.
- 합성 앱의 업무 데이터는 메모리에 있으므로 lab 프로세스를 종료하면 사라진다. 실행 DB와 dedicated profile은 보존한다. API 키·로그인 쿠키·실사용 자료를 이 테스트 팩에 넣지 않는다.

## 검증

실제 SDK initialize/list/call/close, CLI↔MCP 같은 동작/별도 task, 두 gateway 동시 duplicate, 인수 충돌, 다른 project 접근, 실제 navigation barrier 중 gateway SIGKILL, 재연결 뒤 이벤트 redelivery/ack, shared profile 동시 요청 직렬화를 검사한다. 합성 fixture 기반 C01은 fixture_integration으로 기록한다. SDK 1.30.0 / Zod 4.4.3을 고정했다.

프로토콜 근거: [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports). 공식 SDK의 실제 설치 버전 구현과 왕복 검사를 함께 확인했다. stdio 출력은 프로토콜 전용이고 진단 로그는 stderr다.
