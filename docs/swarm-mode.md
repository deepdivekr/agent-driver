# Swarm Mode

Swarm Mode는 하나의 큰 목표를 LLM Supervisor가 작은 작업 그래프로 나누고, 상위 MCP client가 각 작업마다 별도 sub-agent를 소환하도록 강제하는 실행 모드다. “여러 agent가 알아서 협업한다”는 선언이 아니라 계획·임대·보고·검증이 durable state에 결속된 프로토콜이다.

```text
자연어 목표
  → LLM Supervisor가 2~300개 논리 worker DAG 제안
  → 코드가 capability·cycle·worker/concurrency·budget 검사
  → Decision Plane이 현재 runnable worker를 선택
  → MCP client가 해당 worker용 sub-agent를 소환
  → worker가 artifact + 독립 readback을 보고
  → Decision Plane이 품질·다음 단계를 판단
  → 코드가 완료·권한·승인을 다시 검사
```

## 왜 sub-agent 소환이 필수인가

`runtime_swarm_plan`은 worker가 2개 미만인 계획을 거부한다. `runtime_swarm_tick`이 반환하는 dispatch에는 `spawn_sub_agent_required=true`가 들어가며, Agent Driver가 worker 결과를 대신 만들어내지 않는다. Hermes, Codex 또는 다른 MCP orchestrator는 이 dispatch로 별도 실행 문맥을 만들고 `runtime_swarm_report`로 결과를 돌려준다.

현재 adapter는 **orchestrator pull 방식**이다. 즉 Agent Driver가 Kimi/Codex/Hermes의 비공개 spawn API를 내장하지 않는다. 실제 동시 sub-agent 수는 MCP client의 실행 능력과 host 설정 양쪽의 제한을 받는다.

## 300명의 의미

300은 `max_logical_workers` 상한이다. OS 프로세스 300개를 한꺼번에 띄운다는 뜻이 아니다. `max_concurrency` 기본값은 8, 최대값은 32이며 active lease가 이 수에 도달하면 더 이상 dispatch하지 않는다. 논리 worker는 SQLite에 남아 순서대로 실행된다.

```json
{
  "swarm": {
    "enabled": true,
    "model_data_approved": true,
    "max_logical_workers": 64,
    "max_concurrency": 8,
    "lease_ms": 120000
  }
}
```

Swarm Mode는 LLM planner와 model data 승인이 없으면 `SWARM_LLM_PLANNER_REQUIRED` 또는 `MODEL_DATA_APPROVAL_REQUIRED`로 멈춘다. 단일 Pack 실행으로 조용히 강등하지 않는다.

## 공통 Decision Plane

Swarm 전용 catalog는 다음 판단을 제공한다.

- `dispatch.next_actor`: 코드가 만든 dependency-ready 후보 중 다음 worker 선택
- `artifact.quality.relevance`: 목표와 결과의 관련성 점수
- `artifact.quality.evidence`: 독립 검증 근거의 강도 점수
- `artifact.quality.usability`: 후속 worker가 사용할 수 있는 완결성 점수
- `workflow.next_step`: 계속·재관측·LLM 재계획·사람 검토·완료·hold 선택

artifact 품질 세 질문은 같은 state로 한 번에 fan-out하지만 서로의 답을 전제로 하지 않는다. 가중치 `relevance 0.4 / evidence 0.4 / usability 0.2`, 총점 0.75, evidence 0.75 기준은 코드가 적용한다. Jev가 없거나 calibration gate를 통과하지 못하면 LLM structured fallback을 쓰며, 그 결과를 calibrated confidence로 위장하지 않는다.

## 권한과 완료

- LLM/Jev의 plan과 판단에는 항상 `execution_authority=false`, `approval_granted=false`가 기록된다.
- `external_effect`와 `irreversible` worker는 dispatch하지 않고 사람 예외 큐로 보낸다. 기존 snapshot-bound 승인 경로와 결합되기 전에는 실행할 수 없다.
- `succeeded` 보고에는 독립 readback hash와 방법이 필수다.
- lease가 만료되면 자동 재시도하지 않는다. 중복 효과 가능성을 피하기 위해 사람 검토로 보낸다.
- 모든 worker가 readback과 품질 gate를 통과하기 전에는 모델이 `COMPLETE`를 골라도 run을 완료하지 않는다.
- 재계획은 `runtime_swarm_replan`으로 새 LLM plan을 만들며 기존 run과 권한을 자동 상속하지 않는다.

## MCP 흐름

1. `runtime_swarm_plan(goal, context)`
2. `runtime_swarm_run(request_id, plan_id)`
3. `runtime_swarm_tick(run_id)`
4. 반환된 dispatch마다 별도 sub-agent 소환
5. `runtime_swarm_report(run_id, worker_id, lease_token, report)`
6. `runtime_swarm_status(run_id)`
7. 필요 시 `runtime_swarm_replan(run_id, reason)`

현재 검증은 fixture LLM/Jev와 durable SQLite를 사용한 `fixture_integration`이다. 실제 Hermes/Codex가 여러 원격 sub-agent를 동시에 소환하는 user-environment 증거는 아직 별도로 수집해야 한다.
