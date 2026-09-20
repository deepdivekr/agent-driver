# 위임된 파일 작업과 독립 검증 — Phase20

CLI 응답·exit0·도구 성공 메시지는 프로젝트 완료 증거가 아니다. 파일은 runtime broker가 쓰고 hash로 다시 읽는다. 테스트는 별도 snapshot에서 host가 고정한 외부 oracle과 대조한다. 원문 Phase04의 대화형 CLI·Windows·범용 빌드·재부팅 요구를 이 기능으로 대체하지 않는다.

## Host 위임

기본 Read/Edit/Write/Bash·Chrome·다른 MCP·hooks는 계속 비활성화한다. 신뢰된 `host.json`의 `terminal.files`로만 파일 기능을 연다. 모델은 승인·파일 범위·shell·검증 명령을 추가할 수 없다.

```json
{
  "ownership": "exclusive_runtime",
  "read": ["src/app.mjs", "README.md"],
  "write": ["src/app.mjs", "README.md"],
  "max_bytes": 65536,
  "max_writes_per_turn": 8,
  "verifier": {
    "kind": "node_stdio_cases",
    "entry": "src/app.mjs",
    "cases": [{"id": "sum", "args": ["sum", "2", "3"], "stdout": "5"}],
    "timeout_ms": 3000
  }
}
```

`worktree`는 에이전트가 독점 사용하는 작업 사본이다. 사람이 동시에 편집하는 checkout에 이 옵션을 켜지 않는다. 설정과 runtime 데이터는 worktree 밖에 둔다. `.agent-driver-owner.json`이 프로젝트·DB·디렉터리 신원을 결속하며 다른 DB의 쓰기를 거절한다. 소유권을 바꾸려고 이 파일을 자동 삭제하지 않는다.

경로는 정확한 상대 경로다. 읽기 최대64개, 쓰기 최대32개이며 쓰기는 읽기의 부분집합이다. 숨김/인증 경로·절대 경로·역참조·symlink·hardlink·특수 파일·잘못된 UTF-8을 거절한다. 하위 디렉터리는 미리 존재해야 한다. 파일 생성/교체만 지원하며 임의 삭제·이름 변경·shell은 지원하지 않는다.

## Dispatch와 중단

1. host가 현재 턴의 공식 tool-use ID와 정규화 입력 hash를 선기록한다.
2. 실제 CLI의 자식 broker를 kernel process identity로 결속한다.
3. broker는 host/CLI/자신의 생존, config/worktree, generation, 현재 수신 완료 턴, deadline, 취소, 파일 범위를 재검사한다.
4. 변경 전후 content/hash를 SQLite WAL/FULL intent로 확정한다.
5. 단일 writer transaction 안에서 fence/내용 재검사, staging·fsync·rename/link·directory fsync·readback을 수행한다.
6. host는 CLI tool-result를 broker의 durable 결과와 대조한다. 누락·위조 결과나 불명확한 intent를 완료로 통과시키지 않는다.

실제 Claude 2.1.126에서 빈 기본 도구 목록과 별도 stdio MCP, tool allowlist, init의 연결 상태, assistant tool_use/user tool_result를 관측했다. 모든 user 프레임을 prompt receipt로 보는 이전 가정을 수정했다. 최신 공식 문서의 기능을 설치 버전의 증거로 취급하지 않는다. [Claude MCP](https://code.claude.com/docs/en/mcp)

사용자는 자연어 한 줄을 전달한다. runtime이 전송 메시지에 턴 ID를 붙인다. 사용자가 state/question/hash를 작성하지 않는다. 모델은 read 결과의 hash를 write에 사용하고 런타임이 다시 검증한다.

같은 request ID/내용은 이전 결과를 반환하며 다시 쓰지 않는다. 이는 현재 파일이 그대로라는 인증이 아니다. intent 이후 문제가 생기면 `uncertain`으로 보존한다. SQLite rollback이 파일 교체를 되돌렸다고 주장하지 않는다. `runtime_terminal_reconcile_files`는 CLI와 broker의 사망을 확인한 뒤 hash로 desired/previous/unknown을 구분한다. hash 일치만으로 전체 프롬프트를 자동 재개하지 않는다.

동시 사람 편집에 대한 완전한 POSIX compare-and-swap을 주장하지 않는다. 최종 내용 검사와 rename 사이의 외부 writer 경합까지 원자적으로 막는 것은 아니다. 독점 작업 사본 전제와 같은 OS 사용자 공격자 제외가 중요하다. 부분 staging은 불명확한 변경 증거로 남을 수 있으며 자동 삭제하지 않는다.

## 독립 검증

`runtime_terminal_verify` 입력은 request ID·session·generation·expected turn ID다. host가 고정한 Node entry/인수/표준입력/예상 표준출력·오류·종료 코드의 양수 개수 case를 실행한다. 모델이 출력한 “100개 PASS”나 exit0만으로 통과하지 않는다. 예상 출력은 실행된 행동에 대한 외부 oracle이지 프로그램이 스스로 보고한 테스트 개수가 아니다.

위임한 파일만 복사한 snapshot의 hash manifest를 보존한다. Linux bubblewrap의 새 user/mount/pid/network/IPC namespace, 읽기 전용 snapshot, 비공유 tmp, 환경 초기화, 새 session, parent-death kill을 사용한다. home·인증·데스크톱 socket을 노출하지 않는다. CPU/주소 공간/파일/FD·출력·실행 시간을 제한한다. namespace를 사용할 수 없으면 BLOCKED_ENV이며 host에서 대신 실행하지 않는다. [bubblewrap의 보장과 제한](https://github.com/containers/bubblewrap#sandbox-security)

범용 프로젝트 runner가 아닌 Node stdin/stdout/exit 계약 검증기다. dependency install, npm scripts, shell, network를 실행하지 않는다. 프로세스 집합 전체의 cgroup 메모리/CPU/PID 예산과 VM 보안 경계는 별도 출시 gate다. kernel/동일 사용자/DoS 보안 인증은 아니다.

검증 중 새 프롬프트/파일 dispatch를 막는다. 기록은 snapshot·설정·턴·generation에 결속되며 인계 때 파일이 바뀌면 과거 PASS를 현재 PASS로 가져오지 않는다. 테스트 PASS도 모든 업무 조건의 완료는 아니다. `project_completed=false`를 유지한다.

## 증거와 미완료 범위

합성 authority/protocol, 실제 filesystem/namespace, 실제 Claude opt-in 코딩 시험을 구분한다. 실제 CLI의 기존 구독 인증을 사용하며 키를 broker 설정·공개 증거에 복사하지 않는다. 실패 기록도 보존한다.

Windows broker/ConPTY, linked Git worktree 수집, 일반 프로젝트 빌드, 모든 tool/error payload, 강한 보안 격리, 장기 보존·disk pressure·재부팅은 별도 검증 대상이다. Phase20 성공으로 원래 미완료 범위를 삭제하지 않는다.
