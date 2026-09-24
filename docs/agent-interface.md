# Agent interface — Phase 22

## 실제 지원과 남은 범위

CLI와 stdio MCP는 같은 RuntimeApi를 사용한다. 이후 Pack family와 `runtime_channel_route`가 추가되어 고정 개수 대신 MCP `tools/list`의 실제 목록을 기준으로 한다. 조회/인계 계약은 [별도 안내](terminal-handoff.md), 저장 상태·계획·정리·죽은 owner 예약 회수는 [저장 경계](storage-boundaries.md), Hermes/Telegram 경계는 [Hermes + Telegram runtime](hermes-telegram-runtime.md)을 따른다.

Phase 79의 `coding.orchestrate`는 등록 Git 프로젝트에 한정한다. `runtime_coding_projects`로 alias와 Codex/Claude 연결을 확인하고, 명시적인 “마지막 업무 이어가기”에는 `runtime_coding_last`를 먼저 조회한다. 신규 업무는 `runtime_work_start → runtime_coding_start → runtime_coding_step` 순서로 진행하고, 단계마다 `runtime_coding_status`의 revision·영수증을 확인한다. 일시정지·재개는 `runtime_coding_pause`, 만료된 쓰기 소유권 확인은 `runtime_coding_reconcile`이다. 자세한 권한·실행 범위는 [코딩 업무 안내](coding-orchestration.md)를 따른다.

사용 가능: health, capabilities list/describe, task start/status/cancel/resume, recovery status/prepare, artifacts list(미지원/빈 목록 명시), events read/ack, intake. resume/prepare는 안전하게 준비된 미전송 작업에만 적용한다.

terminal start/status/submit_prompt/resume/interrupt는 명시적으로 설정된 Linux Claude 구조화 세션에서 동작한다. 기본 CLI 내장 파일/shell 도구는 차단하며 `terminal.files`가 명시된 host에서만 runtime broker를 사용할 수 있다. [CLI adapter 근거표](cli-adapter-matrix.md)를 먼저 확인한다. 명시적 `NOT_IMPLEMENTED`: browser session open/status. 최상위 `verify`, `soak`, `ops` CLI 역시 미구현이며 help에 표시한다(`terminal verify`와 구분). 이 목록을 MCP 완전 구현이나 공식 릴리즈 완료라고 부르지 않는다.

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

마지막 명령은 MCP 클라이언트가 시작할 프로세스다. 일반 대화형 프롬프트를 읽지 않으며 JSON-RPC만 처리한다. Hermes는 `agent-driver hermes configure`가 현재 Node executable과 절대 `dist/cli.js` 경로를 보존적으로 등록한다. Phase 36에서 공식 Hermes CLI의 실제 stdio 연결·도구 발견을 검증했으며, Telegram end-to-end 실행은 유효한 secret과 model auth를 갖춘 별도 user-environment 검증이다.

원문 한 줄만 전달하면 `NEEDS_EXTRACTION`과 좁은 인수 질문을 돌려준다. 호출 agent가 자신의 모델로 추출한 `name`, `note` 값과 UTF-16 `[start,end)` 원문 범위를 proposal로 전달하면 범위를 검증한다. 결과는 항상 `dispatch_allowed=false`; 범위 일치는 사용자 의도의 의미적 정답을 보장하지 않는다. 창작/다중 작업/모호한 지시/빠진 값은 호출 agent가 확인하며 지원 부분만 임의 실행하지 않는다. 사용자는 state/question을 작성하지 않는다. 이 설명은 위 합성 fixture의 인수 추출에 한정한다. 현재 Work 접수와 AI 연결에는 MCP sampling·API 및 선택형 Jev가 별도로 제공되며, 이 fixture의 `dispatch_allowed=false`가 해당 기능의 부재를 뜻하지 않는다.

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

Phase22는 기존 v1~v5 DB를 v6로 migration한다. 저장 예약·자료 소유권·분할 로그 메타데이터를 추가하며 기존 intent/event는 보존한다. 현재 v6 DB 재오픈은 migration 쓰기를 생략해 실제 공간 부족에서도 읽기 경로를 유지한다. 구버전 실행 파일로 v6 DB를 열지 않는다. 백업/복원·설정 migration은 아직 출시 gate다.

Phase20은 기존 DB v1~v4의 기록을 보존하며 v5로 올린다. v5는 file broker identity, 공식 tool call, file intent, independent verification을 추가한다. 파일 기능은 `terminal.files`가 있는 host에만 켜지며 정확한 범위와 명령은 [파일 작업 안내](terminal-file-effects.md)를 따른다. `runtime_terminal_verify`와 `runtime_terminal_reconcile_files` 2개 도구가 추가되었다. CLI는 `terminal verify|reconcile-files --config PATH --request-file PATH`다. 과거 v4 설명은 당시 migration 단계이며 구버전 실행 파일로 v5를 열지 않는다.

실제 SDK initialize/list/call/close, CLI↔MCP 같은 동작/별도 task, 두 gateway 동시 duplicate, 인수 충돌, 다른 project 접근, 실제 navigation barrier 중 gateway SIGKILL, 재연결 뒤 이벤트 redelivery/ack, shared profile 동시 요청 직렬화를 검사한다. 합성 fixture 기반 C01은 fixture_integration으로 기록한다. SDK 1.30.0 / Zod 4.4.3을 고정했다.

프로토콜 근거: [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports). 공식 SDK의 실제 설치 버전 구현과 왕복 검사를 함께 확인했다. stdio 출력은 프로토콜 전용이고 진단 로그는 stderr다.
