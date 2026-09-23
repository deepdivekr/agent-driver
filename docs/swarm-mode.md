# Swarm Mode

## Automatic visual workers

Host 설정의 `swarm.visual.enabled: true`는 `runtime_swarm_start`와 `runtime_swarm_tick`이 반환하는 웹 조사 worker에 브라우저를 자동 배정한다. `max_contexts`(기본 16)로 동시 화면 수를 제한하며 `frame_interval_ms`(기본 1000)로 미리보기 간격을 정한다. 별도 surface 주소를 worker마다 작성하지 않는다. 이 기능은 Chromium이 설치된 런타임에서 사용하며 기존 설정의 기본값은 비활성이다.

```json
{"swarm":{"enabled":true,"model_data_approved":true,"visual":{"enabled":true,"max_contexts":16,"frame_interval_ms":1000}}}
```

이 설정 조각은 기존 host 설정의 `swarm` 항목에 병합한다. **기본값**은 source worker마다 비영속 BrowserContext와 Page 하나이며 쿠키·저장소·화면이 분리된다. 같은 Chromium 프로세스를 쓰므로 worker별 보안 VM은 아니다. `visual.owned_vm`을 명시하면 전용 VM의 persistent profile을 공유하고 worker별 Page만 분리한다. 이 모드에서는 로그인 preflight와 사람에게 넘기는 연결 화면을 사용한다. 어느 모드도 개인 브라우저 로그인을 자동 복사하지 않는다. [persistent 연결 경계](browser-connections.md).

`surface_id`가 있는 dispatch의 sub-agent는 `runtime_swarm_browser`에 run/worker/lease와 `navigate`, `observe`, `scroll` 명령을 전달한다. 최초 주소는 배정된 source URL, 후속 주소는 해당 worker가 실제 페이지에서 관측한 링크만 사용한다. 이 도구에는 임의 스크립트 실행·폼 제출·다운로드 명령이 없으며 다른 Pack의 기존 쓰기 권한을 확장하지 않는다. 웹 읽기와 코드 동작은 CODE 활동으로, report의 실제 Jev/LLM 판단은 해당 provider 활동으로 기록한다.

작업 완료·lease 만료·실행 종료 시 브라우저 context를 회수한다. 관제센터는 registry의 run/worker 결속으로 독립 화면을 자동 표시하고, 실행 중 화면과 종료된 마지막 프레임을 구분한다. 브라우저가 필요 없는 reduction/synthesis는 상태 타일만 갖는다. 일반 LLM client가 별도 브라우저로 직접 조사하면 그 화면은 이 wall의 증거가 아니다.

Swarm Mode는 하나의 큰 목표를 LLM Supervisor가 작은 작업 그래프로 나누고, 상위 MCP client가 각 작업마다 별도 sub-agent를 소환하도록 강제하는 실행 모드다. “여러 agent가 알아서 협업한다”는 선언이 아니라 계획·임대·보고·검증이 durable state에 결속된 프로토콜이다.

```text
자연어 목표
  → 조사·비교·다중 출처 요청은 runtime_swarm_start (mode 생략 시 standard)
  → LLM Supervisor가 URL 1~2개 단위 source worker DAG 제안
  → 코드가 capability·cycle·worker/concurrency·budget 검사
  → 코드는 dependency-ready 안전 worker를 dispatches[]로 batch lease
  → MCP client가 dispatch별 sub-agent를 가능한 한 동시에 소환
  → worker가 artifact + 독립 readback을 보고
  → Decision Plane이 품질·다음 단계를 판단
  → 코드가 완료·권한·승인을 다시 검사
```

## 왜 sub-agent 소환이 필수인가

`runtime_swarm_plan`은 worker가 2개 미만인 계획을 거부한다. `runtime_swarm_start`와 `runtime_swarm_tick`이 반환하는 각 dispatch에는 `spawn_sub_agent_required=true`가 들어가며, Agent Driver가 worker 결과를 대신 만들어내지 않는다. Hermes, Codex 또는 다른 MCP orchestrator는 `dispatches[]`의 각 항목으로 별도 실행 문맥을 만들고, client·host 상한 안에서 가능한 한 동시에 시작한 뒤 `runtime_swarm_report`로 각 결과를 돌려준다.

현재 adapter는 **orchestrator pull 방식**이다. 즉 Agent Driver가 Kimi/Codex/Hermes의 비공개 spawn API를 내장하지 않는다. 실제 동시 sub-agent 수는 MCP client의 실행 능력과 host 설정 양쪽의 제한을 받는다.

## 300명의 의미

300은 범용 `max_logical_workers` 절대 상한이다. OS 프로세스 300개를 한꺼번에 띄운다는 뜻이 아니다. Standard 조사는 출처 범위가 충분할 때 최소 8, 최대 24 logical worker를 계획하고, 목표 동시성은 16이다. 실제 배치는 host 정책과 MCP client 상한 중 더 낮은 값을 준수한다. 논리 worker는 SQLite에 남고 dependency stage 단위로 실행된다.

```json
{
  "swarm": {
    "enabled": true,
    "model_data_approved": true,
    "max_logical_workers": 24,
    "max_concurrency": 16,
    "lease_ms": 120000
  }
}
```

Swarm Mode는 LLM planner와 model data 승인이 없으면 `SWARM_LLM_PLANNER_REQUIRED` 또는 `MODEL_DATA_APPROVAL_REQUIRED`로 멈춘다. 단일 Pack 실행으로 조용히 강등하지 않는다.

## Standard 조사 정책

`runtime_swarm_start`의 `mode`를 생략하면 `standard`가 적용된다. Standard는 목표 wall time 3분, hard deadline 4분, source worker timeout 75초, 최종 synthesis reserve 35초를 사용한다. 상위 host가 더 작은 시간·worker·동시성 한도를 정했다면 그 한도가 우선한다.

- 독립 source worker는 URL 1~2개만 담당하고 같은 dependency stage에 놓는다.
- source worker는 구조화된 fact card와 출처 근거를 반환한다.
- reducer와 synthesis worker는 source worker 뒤에 놓아 수집 단계와 종합 단계를 겹치지 않는다.
- 새 source worker가 synthesis reserve를 침범할 예정이면 추가 수집을 멈추고 이미 확보한 evidence로 종합한다.
- hard deadline을 넘긴 run은 `completed`로 표시하지 않고 `partial_evidence` 또는 검토 상태로 남긴다.

이 정책은 읽기 중심 조사의 속도와 근거 품질을 다루며 외부 효과 권한을 확장하지 않는다.

## 공통 Decision Plane

Swarm 전용 catalog는 다음 판단을 제공한다.

- `dispatch.next_actor`: capability·효과·우선순위 차이 때문에 순서가 실제 결과에 영향을 줄 때만 dependency-ready 후보 중 다음 worker 선택
- `artifact.quality.relevance`: 목표와 결과의 관련성 점수
- `artifact.quality.evidence`: 독립 검증 근거의 강도 점수
- `artifact.quality.usability`: 후속 worker가 사용할 수 있는 완결성 점수
- `workflow.next_step`: 계속·재관측·LLM 재계획·사람 검토·완료·hold 선택

artifact 품질 세 질문은 같은 state로 한 번에 fan-out하지만 서로의 답을 전제로 하지 않는다. 가중치 `relevance 0.4 / evidence 0.4 / usability 0.2`, 총점 0.75, evidence 0.75 기준은 코드가 적용한다. Jev가 없거나 calibration gate를 통과하지 못하면 LLM structured fallback을 쓰며, 그 결과를 calibrated confidence로 위장하지 않는다.

서로 독립이고 `read_only + sub_agent + 추가 capability 없음`인 runnable worker들의 dispatch 순서는 의미가 없다. 이 경우 모델에게 순서를 묻지 않고 코드가 안정 정렬로 즉시 lease를 발급한다. 모델 호출을 줄이는 최적화이자, 무의미한 저확신 판단이 병렬 처리를 막지 않게 하는 안전 규칙이다.

중간 worker와 최종 worker의 품질 gate도 다르다. 후속 verifier가 있는 중간 worker는 bounded evidence manifest와 독립 readback이 있으면 그 verifier에게 전달하며, Jev의 원자 품질 점수는 감사·우선순위 신호로 보존한다. 최종 worker만 총점 0.75와 evidence 0.75를 모두 만족해야 완료 근거가 된다. 중간 결과를 최종 증거처럼 심사하면 교차검증 worker가 아예 실행되지 않는 순환 문제가 생기기 때문이다.

worker report는 hash만 전달하지 않는다. 최대 32개의 `{source_url, claim, observed_at, verification}` evidence manifest를 품질 state에 포함한다. journal은 원문 state 대신 Choice/Score의 전체 확률분포, selected probability, confidence, provider latency, 가능한 경우 input/output token 수를 보존한다. 이것들은 통계 검정의 p-value가 아니다.

## 권한과 완료

- LLM/Jev의 plan과 판단에는 항상 `execution_authority=false`, `approval_granted=false`가 기록된다.
- `external_effect`와 `irreversible` worker는 dispatch하지 않고 사람 예외 큐로 보낸다. 기존 snapshot-bound 승인 경로와 결합되기 전에는 실행할 수 없다.
- `succeeded` 보고에는 독립 readback hash와 방법이 필수다.
- lease가 만료되면 자동 재시도하지 않는다. 중복 효과 가능성을 피하기 위해 사람 검토로 보낸다.
- 모든 worker가 readback과 품질 gate를 통과하기 전에는 모델이 `COMPLETE`를 골라도 run을 완료하지 않는다.
- 재계획은 `runtime_swarm_replan`으로 새 LLM plan을 만들며 기존 run과 권한을 자동 상속하지 않는다.

## MCP 흐름

1. 독립 조사·비교·다중 출처 요청은 `runtime_swarm_start(request_id, goal, context?, mode?)`
2. 반환된 `dispatches[]`를 가능한 한 동시에 각각 별도 sub-agent로 소환
3. 각 worker가 시작하거나 실제 endpoint/단계가 바뀔 때 `runtime_swarm_activity`로 query·본문·credential 없는 짧은 heartbeat를 보고
4. 각 결과를 `runtime_swarm_report(run_id, worker_id, lease_token, report)`로 보고
5. `runtime_swarm_tick(run_id)`으로 다음 dependency-ready batch를 받아 2~4번 반복
6. `runtime_swarm_status(run_id)`로 상태와 partial evidence를 확인
7. 필요 시 `runtime_swarm_replan(run_id, reason)`

기존 low-level `runtime_swarm_plan` → `runtime_swarm_run` 흐름은 계속 지원한다. `runtime_swarm_tick`은 batch 필드 `dispatches[]`를 추가하지만, 기존 client 호환을 위해 첫 항목을 단일 `dispatch`에도 유지한다. batch가 비었으면 `dispatch` 역시 `null`이다.

## 통합 관제 화면

```bash
agent-driver dashboard --config /absolute/path/to/host.json
```

명령은 `127.0.0.1`에 읽기 전용 HTTP/SSE 서버를 열고 매 실행마다 새 임의 capability URL을 출력한다. 현재 화면은 Swarm 전용이 아니라 Pack·Task·CLI·MCP heartbeat까지 같은 시간축에 합친 **Agent Driver Control Center**다. 종류별 필터에서 Swarm을 선택하면 각 worker의 stage·executor·작업·시도 횟수·품질과 durable activity를 본다. 새로고침하거나 dashboard process를 다시 시작해도 SQLite journal에서 이력을 복원한다. 전체 계약은 [Control Center](control-center.md)에 있다.

계획에 들어 있던 source URL은 기본 endpoint다. 실행 중 worker가 `runtime_swarm_activity`를 보고하면 현재 활동(`navigating`, `observing`, `tool_call`, `checkpoint`)과 정리된 실제 endpoint가 즉시 우선 표시된다. 유효한 lease를 가진 worker만 heartbeat를 쓸 수 있고, heartbeat는 권한·승인·완료를 만들지 않는다.

URL은 `origin + pathname`까지만 표시한다. userinfo, query, fragment와 token·session처럼 보이는 긴 path segment는 제거한다. 작업 설명에 포함된 credential-like 문자열도 redaction한다. 관제 snapshot·SSE·frame은 읽기 전용이다. Task가 인증 필요성을 발견했을 때 나타나는 `사이트 로그인` 화면은 해당 사이트만 same-origin POST로 열기·확인·재시도하며, 작업 승인·제출·구매 권한은 주지 않는다. Agent Driver는 사이트별 약관을 판정하거나 특정 API를 강제하지 않는다. [사이트 연결](browser-connections.md)을 참고한다.

현재 검증은 fixture LLM/Jev와 durable SQLite를 사용한 `fixture_integration`이다. 실제 Hermes/Codex가 여러 원격 sub-agent를 동시에 소환하는 user-environment 증거는 아직 별도로 수집해야 한다.
