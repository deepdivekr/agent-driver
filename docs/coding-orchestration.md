# 코딩 업무 오케스트레이션 (실험적)

`coding.orchestrate`는 한 줄 Work를 등록한 **로컬 Git 프로젝트**에 결속하고 Codex·Claude Code의 작업을 순서대로 인계하는 MCP 경로다. GitHub 계정이나 원격 저장소는 필요하지 않다. 연결한 에이전트가 지휘하며, Agent Driver는 계획 검증·프로세스 호출·세션 ID·단계 결과·중단 상태를 보존한다. Jev 연결은 필요하지 않다.

## 프로젝트 등록

Ubuntu/WSL 호스트 설정 JSON의 `coding` 항목에 작업할 프로젝트를 등록한다. 예시는 Linux/WSL 경로다. 실제 경로와 검사 명령은 본인의 환경에 맞게 정한다.

```json
{
  "coding": {
    "model_data_approved": true,
    "projects": [
      {
        "id": "my-project",
        "root": "/home/me/projects/my-project",
        "allow_write": true,
        "allow_commit": false,
        "verify": []
      }
    ]
  }
}
```

이 JSON은 기존 `host.json` 최상위 객체의 일부다. `root`는 존재하는 Git 저장소의 절대 경로여야 하고, 실행 시 실제 Git 최상위 경로와 다시 대조한다. `allow_write`가 없으면 읽기 전용이다. `allow_commit`은 별도로 켜야 하며 쓰기 허용이 선행된다. 프로젝트 검사를 추가하려면 `verify`에 실제 설치된 실행 파일의 절대 경로, 인수 배열, 제한 시간을 지정한다. `model_data_approved`는 코드·문서 발췌와 요청이 연결한 모델에 전달됨을 알고 켜는 항목이다. 호스트 설정을 바꾼 뒤 MCP 프로세스를 다시 시작해야 새 프로젝트가 반영된다. CLI 인증은 공식 Codex/Claude Code 로그인 상태를 그대로 사용하며 토큰을 가져와 저장하지 않는다.

체크포인트를 사용하려면 로컬 저장소에 최소 한 개의 커밋(`HEAD`)이 있어야 한다. 원격 GitHub 등록·푸시는 요구하지 않는다.

## 사용 흐름

새 요청 예: “my-project에서 기능을 구현하고 Codex로 작업한 차이를 Claude가 검토해줘.”

1. 연결한 에이전트가 `runtime_work_start`로 영속 Work를 만든다.
2. `runtime_coding_projects`에서 등록 alias와 공식 CLI 연결 상태를 확인하고, `runtime_coding_start`에 `work_id`, 동일한 첫 `request_id`, `project_ref`를 넘긴다.
3. LLM이 `implement`, `review`, `document`, `marketing`, 선택적 `commit_readme` 단계를 제안한다. 코드는 배우·작업 유형·파일 대상·쓰기/커밋 위임을 검사한다.
4. 에이전트가 `runtime_coding_step`을 호출하고 반환된 `revision`과 단계 영수증을 보고 다음 단계만 이어간다. 관제 Work 상세에서 단계·담당 CLI·진척·일시정지·미시작 단계 지침 수정을 볼 수 있다.

## 로컬 Git 인계 체크포인트

새 Run을 만들 때 README의 안전한 발췌, 추적된 최상위 항목·프로젝트 설정 파일로 짧은 코드베이스 지도를 만든다. 이 지도는 계획 모델에 전달되며, 실제 실행 단계에서는 작업 목표·완료 조건·검증된 단계·미완료 단계·다음 행동과 함께 다음 클라이언트 입력에 **직접 포함**된다. 단순히 “파일을 읽어라”라고 요청하는 방식이 아니다.

단계 시작·종료 시 로컬 Git의 `HEAD`, 추적 파일 diff, 미추적 파일의 지문을 대조한다. SQLite의 단계 영수증과 Git 지문이 기준이고, 읽기 쉬운 Markdown은 Git 내부의 `agent-driver/handoffs/<run-id>.md`에 원자적으로 투영한다. 일반 저장소에서는 `.git/agent-driver/handoffs/` 아래에 있다. Git worktree의 `.git`이 파일이면 해당 worktree의 실제 Git 관리 디렉터리에 저장한다. 작업 트리에 새 파일을 만들지 않으므로 사용자의 변경 목록이나 커밋에 섞이지 않는다. 이 파일을 누군가 수정해도 다음 실행 전에 SQLite 기록에서 다시 생성한다.

외부에서 파일이나 커밋 상태를 바꾼 경우 다음 단계는 `CODING_GIT_CHECKPOINT_CHANGED`로 **CLI 호출 전에 거부**된다. 원래 상태로 되돌려 재시도하거나 변경을 검토한 뒤 새 Work로 계획해야 한다. 중단된 쓰기의 효과가 불확실하면 기존대로 `reconciliation_required`를 유지하고 자동 재실행하지 않는다. GitHub 푸시·자동 커밋은 추가되지 않는다. Git 내부의 Markdown은 로컬 전용으로, 원격 GitHub에 올라가지 않는다. Git 관리 디렉터리나 런타임 SQLite를 잃으면 이 로컬 인계 기록도 잃을 수 있으므로 원격 동기화/백업 기능으로 간주하지 않는다.

“my-project의 마지막으로 중단된 코딩 업무 이어서 진행해줘”에는 새 Work를 만들기 전에 `runtime_coding_last`로 마지막 미완료 Run을 찾는다. `ready`면 `runtime_coding_step`, `paused`면 명시적 재개, `reconciliation_required`면 먼저 `runtime_coding_reconcile`로 변경 상태를 확인한다. 안전성이 확인되지 않은 쓰기 단계는 자동으로 재실행하지 않는다. Work가 완료된 다음 새 반복 실행에는 새로운 request ID가 필요하다.

## 실행·인계 경계

- Codex 구현은 공식 `codex exec --json`을 등록 프로젝트에서 `workspace-write`와 비대화형 승인 거부로 실행한다. 첫 쓰기 단계는 깨끗한 Git 작업 트리를 요구한다. 후속 Codex 단계는 같은 Run에 저장된 정확한 세션 ID로만 `exec resume`한다. 전역 `--last`는 사용하지 않는다.
- Claude 검토·문서·소개문은 공식 `claude -p --output-format json`을 도구·MCP·브라우저 없이 사용한다. 검토에는 변경분과 허용된 소스 파일만 전달한다. 모델의 검토 결과와 설정된 검사 명령은 구별한다.
- README 수정은 Claude가 내용을 생성하고 코드가 기존 파일의 해시 재확인 뒤 `README.md`만 쓴다. 로컬 커밋은 사용자가 요청에 “커밋”을 포함하고 `allow_commit`이 켜졌을 때만 별도 코드 단계가 `README.md` 하나를 커밋한다. 푸시·배포·임의 Git 복구는 하지 않는다.
- 모델이 고른 소스 파일은 Git 추적 목록에 있는 프로젝트 내부 일반 파일만 읽고 파일당 12 KiB, 전체 48 KiB로 제한한다. 알려진 secret 파일명과 credential 패턴은 거부한다. 소개문 경로는 무관한 변경분을 모델에 전달하지 않는다. 이는 저장소 전체의 비밀정보 유출을 완전히 막는 보안 샌드박스가 아니므로 민감한 프로젝트에는 별도 격리가 필요하다.
- SQLite에 단계·담당·세션 ID·시작/완료·검증 영수증과 30초 소유권 lease를 저장한다. 프로세스 소유권이 만료된 쓰기 작업은 `reconciliation_required`이며 자동 replay되지 않는다. 일시정지는 다음 단계 배정만 막고 이미 돌고 있는 CLI 호출을 즉시 취소하지 않는다.
- Git 작업 트리의 상태에는 무시된 파일 내용이 포함되지 않는다. README 발췌와 프로젝트 파일은 계속 비신뢰 자료이며, 알려진 키 형태는 발췌에서 제외하지만 완전한 비밀 탐지나 코드베이스 전체 이해를 보증하지 않는다.

## 현재 검증과 제약

임시 Git 프로젝트에서 정확한 세션 ID 재개 인수, README 단독 커밋, 읽기 전용 소개문, 권한 거부, owner 만료·중복 방지와 로컬 Git 인계·외부 변경 차단·재시작을 fixture integration으로 검사했다. WSL의 Codex·Claude CLI 설치와 구독 로그인 상태를 확인했고, 별도 임시 Git 저장소에서 **실제 Codex 파일 수정→Claude 구조화 검토** native 왕복에 성공했다. Phase 81 당시 전체 quick 회귀는 493/493 통과했으며 최신 공개 사본의 결과는 [alpha.19 검증 기록](release-readiness-alpha-19.md)에 별도로 남긴다. 실제 사용자 코드베이스에 대한 native 왕복은 미실시다. 한 번의 Run 성공도 Work의 모든 완료조건 충족을 자동 의미하지 않는다. 기존 외부 CLI 세션을 검색해서 가져오는 기능, 실패한 쓰기를 판단 없이 복구하는 기능, 임의 파일 커밋·푸시·배포는 미지원이다. 현재 지휘 에이전트가 각 단계의 MCP 호출을 이어가며, 호스트 프로젝트 등록은 설정 파일에서 한다.

[MCP 도구](agent-interface.md) · [공개 검증 범위](release-readiness-alpha-19.md)
