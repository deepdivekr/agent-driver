# 공통 Decision Plane

Decision Plane은 모든 Pack이 Jev와 비교 모델을 같은 방식으로 호출·검증·평가하게 하는 내부 계층이다. 실행기나 승인 시스템을 대체하지 않는다.

```text
한 줄 요청
  → LLM이 최초 Decision Catalog와 완료 조건 설계
  → 코드가 현재 관측·capability에서 후보 materialize
  → Jev가 서로 독립인 Choice / Noul / Score를 한 batch로 판단
  → 판단 ID별 calibration profile로 accept / review / no_match / shadow_only
  → 권한·승인·freshness를 코드가 별도 검사한 뒤 executor 실행
  → 재관측과 독립 readback → outcome label
```

Jev 연결은 선택 사항이다. 키가 없으면 `skipped_not_configured`로 남기고 첫 판단부터 MCP client 또는 로그인된 Codex·Claude Code·Cursor의 구조화 LLM으로 보낸다. 키가 있더라도 Jev unavailable·저신뢰·no-match는 같은 LLM 경로로 보정한다. 두 경로 모두 같은 code-owned 후보·schema·권한 검사와 독립 readback을 통과한다.

## 계약

- `DecisionCatalog`는 판단 ID, primitive, 위험도, 질문 버전, 명시적 no-match 값과 fallback을 고정한다. 질문과 primitive가 catalog와 다르면 호출을 거부한다.
- 후보는 모델이 새로 만들지 않고 현재 element table, 연결된 source, 허용 operation처럼 코드가 관측한 범위에서 만든다. `NONE`, `UNKNOWN`, `REVIEW`를 숨기지 않는다.
- `DecisionCalibrationProfile`은 catalog hash, 모델, 판단 ID와 결속된다. 전역 confidence 하나를 모든 판단에 적용하지 않는다.
- provider 응답은 probability 범위·합계·Choice 최대값·질문 ID를 검사한다. confidence는 분포의 모양이지 정답 보증이나 권한이 아니다.
- 모든 event는 state 본문 대신 hash, profile/catalog 버전, 지연, typed 결과, shadow 불일치만 append-only JSONL로 남긴다. 사후 readback/human label은 별도 label event로 추가한다.
- `execution_authority=false`, `approval_granted=false`는 불변이다. Decision Plane이 클릭 후보를 골라도 제출·구매·수정 승인을 만들 수 없다.

## 판단별 calibration

`fitDecisionCalibration`은 라벨을 판단 ID별로 나누고, 서로 겹치지 않는 train/holdout ID를 요구한다. 위험도별 최소 표본과 목표 precision을 만족한 head만 `labeled_holdout` 규칙을 얻는다. 관측 precision 자체가 아니라 지정 신뢰수준의 Wilson 하한이 목표 precision 이상이어야 한다. 표본 부족, 목표 미달, irreversible 판단은 `shadow_only`로 남는다.

초기 제품 기본값은 안전한 provisional gate일 뿐 보정 완료값이 아니다. 운영 순서는 다음과 같다.

1. shadow event와 독립 readback label을 수집한다.
2. 후보 누락·provider 오답·실행기 실패·검증 실패를 분리한다.
3. train으로 threshold 후보를 맞추고 잠긴 holdout으로 precision을 검증한다.
4. catalog 질문·모델·도메인이 바뀌면 기존 profile hash를 폐기한다.
5. live 승격 뒤에도 고신뢰 결과 일부를 결정론적으로 무작위 표본 감사한다.

Choice와 Score의 calibration strength는 `min(confidence, selected_probability)`다. Noul은 confidence 필드가 없으므로 `2 * abs(p - 0.5)`를 certainty로 쓴다. 따라서 `p=0.01`과 `p=0.99`는 모두 0.98의 강한 판단이며, 음성 판단을 저신뢰로 잘못 버리지 않는다.

## 운영 폐쇄 루프

판단 event와 label은 `event_id + question_id + decision_id + split`에 정확히 결속된다. orphan, binding mismatch, 중복·충돌 label, catalog/model drift는 보고에는 남지만 dataset에는 들어가지 않는다. 자동 readback은 우선 `unassigned`이며, 독립적으로 잠근 split manifest 없이 holdout으로 승격되지 않는다.

```text
central journal
  -> decision report
  -> locked train/holdout fit
  -> immutable content-addressed candidate
  -> local operator promote
  -> active profile
  -> shadow audit / rollback
```

프로필 파일은 내용 hash로 주소화하며 활성 포인터는 원자적으로 교체한다. symlink·hardlink·과대 파일·hash 불일치는 거부한다. `production` 승격은 `user_environment` evidence만 허용한다. 모델, Hermes, MCP에는 승격 권한이 없고 MCP의 `runtime_decision_status`는 집계 상태만 읽는다.

로컬 운영 명령은 다음과 같다. 원문 state, credential, 승인 token은 출력하지 않는다.

```bash
agent-driver decision status   --root PATH --catalog CATALOG.json --scope production
agent-driver decision report   --events EVENTS.jsonl --labels LABELS.jsonl --catalog CATALOG.json --model jev-latest
agent-driver decision fit      --root PATH --events EVENTS.jsonl --labels LABELS.jsonl --catalog CATALOG.json --model jev-latest
agent-driver decision promote  --root PATH --catalog CATALOG.json --profile SHA256 --scope production
agent-driver decision rollback --root PATH --catalog CATALOG.json --scope production
```

## shadow evaluation

primary와 shadow는 같은 state와 typed 질문을 병렬로 받지만 shadow는 live 결과를 바꾸지 않는다. 현재 adapter는 다른 System One provider 또는 구조화 LLM baseline을 받을 수 있다. LLM adapter의 one-hot probability는 비교 형식일 뿐 calibrated confidence로 취급하지 않는다.

저장하는 핵심 지표는 판단별 불일치, provider 지연, unavailable/invalid 응답, 고신뢰 오답, fallback 뒤 최종 readback이다. Jev 사용 여부는 “선택지가 짧다”만으로 정하지 않고 같은 판단에서 latency·precision·fallback 비용의 marginal value가 확인되어야 한다.

## 검증된 사례 메모리 (Phase 65)

LLM이 Jev의 판단을 보정하면 우선 **후보**로 저장한다. 코드가 별도로 확인한 결과와 일치하는 후보만 다음 실행의 Jev state에 `verified_previous_cases`로 전달한다. 모델 가중치를 학습하거나 이전 답을 그대로 실행하는 기능은 아니다. 현재 관측과 같은 질문으로 Jev를 다시 호출하며, 기존 confidence·승인·완료 기준을 유지한다.

현재 자동 연결한 경로는 읽기 전용 Swarm의 `workflow.next_step`이다. 미완료 worker·실패·검토 대기·실행 가능 작업 수를 코드로 집계하고, DB에 확정된 실행 상태와 대조해 `CONTINUE`와 `COMPLETE` 사례를 검증한다. 이 검증은 **작업 그래프 상태**에 대한 것이며 기사 내용의 진실성을 증명하지 않는다. `artifact.quality`의 LLM 점수는 독립 정답 검증이 없어 후보로만 저장하고 참고 입력으로 사용하지 않는다. 다른 Family·브라우저 클릭 판단은 아직 자동 사례 수집에 연결하지 않았다.

`workflow.next_step` 질문 v2는 이미 실행 중인 worker를 기다리는 것도 `CONTINUE`로 정의한다. 완료된 품질 심사를 다시 열지 않도록 개별 품질 점수는 progress state에서 제외하고 worker 상태만 전달한다. Jev와 LLM에 같은 checkpoint 규칙을 사용한다. catalog/question hash가 바뀌므로 v1 사례와 calibration을 v2에 자동 이식하지 않는다.

기존 활성 calibration이 이전 catalog에 묶여 있으면 Swarm은 LLM 판단으로 계속 진행한다. 상태 조회에는 `DECISION_ACTIVE_CATALOG_MISMATCH`를 남기며 이전 파일을 덮어쓰거나 새 provisional 기준으로 조용히 완화하지 않는다. 새 catalog의 profile 이관·운영 승격은 운영자 절차로 남긴다.

- 사용자 프로젝트, 호스트 설정, Pack 목표·worker 구성, 질문, catalog, calibration profile, provider와 요청 모델을 hash로 결속한다. 새 실행 ID는 결속에서 제외하지만 같은 실행의 사례는 재사용하지 않는다.
- 실제 응답 모델이 사례의 모델과 다르거나, 현재 코드 관측과 답이 충돌하면 해당 참고 사례를 폐기하고 LLM으로 넘긴다. alias 모델 교체는 응답 후에 확인하므로 첫 요청에 과거 사례가 포함될 수 있지만 그 답을 채택하지 않는다.
- 상태 특징은 코드가 만든 수치·불리언·null, 답은 제한된 enum·수치만 저장한다. 사이트 원문, 비밀번호, 보정 문장을 예제로 저장하지 않는다.
- 기존 SQLite에 영속 저장한다. 사례 유효기간은 7일, 요청당 최대 3개다. scope당 활성 512개, 프로젝트당 전체 10,000개로 수집을 제한하며, 가득 차면 신규 학습만 건너뛴다. 현재 오래된 행 자동 삭제는 하지 않는다.
- 검증 라벨은 `unassigned`로 남는다. 입력 사례 재사용과 통계적 threshold calibration은 별개이며, fit·잠긴 holdout·운영 승격 절차를 우회하지 않는다.
- `runtime_decision_status.memory`는 후보·검증·거부·폐기 개수만 반환한다. MCP/모델에 정답 라벨 등록이나 profile 승격 도구를 추가하지 않았다.

따라서 두 번째 실행이 반드시 빨라지는 것은 아니다. 참고 사례로 Jev의 유효 판단이 늘어야 LLM 호출이 줄어든다. 사이트 로딩·자료 생성 시간은 별도이며, 참고 사례를 넣어도 품질 판단에서 계속 LLM이 필요할 수 있다.

## 차용한 OSS 패턴

| 출처 패턴 | 반영한 시스템 | 그대로 복사하지 않은 경계 |
|---|---|---|
| `jev-ultrafast`의 한 요청 내 operation/target/value speculative heads | adaptive browser가 상태·행동·대상·값·완료·정체·방해를 같은 관측에서 fan-out | 한 질문의 답을 다른 질문이 전제로 삼지 않음 |
| `jev-for-chrome`의 complete/stuck 독립 판정 | 완료 주장과 정체·방해 판정을 별도 Noul로 확인 | 완료 판정만으로 성공 처리하지 않고 readback 수행 |
| `jev-agent-browser`의 상위 agent handoff | 실패 reason, 마지막 상태·행동, event ID를 구조화해 Hermes/LLM에 반환 | 하위 모델이 scope나 승인 확대 불가 |
| `jevcal`류 per-question calibration·active audit | 판단 ID별 profile, 잠긴 holdout, 고신뢰 무작위 감사 | confidence를 개별 정답 확률로 오해하지 않음 |
| provider-compatible `open-jev` 접근 | `DecisionProvider` 인터페이스로 교체·로컬 비교 가능 | 공식 Jev와 동등하다고 주장하지 않고 별도 shadow 검증 |
| Jev skill-router의 제한적 이득 사례 | marginal-value shadow gate | bounded choice라는 이유만으로 Jev를 강제하지 않음 |

## 현재 연결 범위와 제약

- adaptive browser: operation/target/value와 complete/stuck/obstruction을 한 batch로 판단하고 저신뢰·no-match·반복을 correction LLM/Hermes로 넘긴다.
- Family runtime: 검색 relevance와 inbox 분류가 같은 profile·journal·fallback 계약을 쓴다.
- Telegram/intake: route·field candidate·supplied 판단이 같은 typed validation을 거친다.
- 실제 production profile은 아직 도메인별 새 shadow label이 누적되어야 한다. 기존 v4 대규모 평가 데이터는 설계 근거이며, 질문·모델 hash가 다른 새 판단의 검증 라벨로 자동 전용하지 않는다.
- provider가 실패해도 authority가 넓어지지 않는다. catalog에 고정된 fallback만 적용하고, 외부 효과는 기존 task-bound single-use approval과 독립 readback을 계속 요구한다.
- provider cascade와 인증 경계는 [구독 인증 LLM bridge](subscription-auth.md)를 따른다. 구독 OAuth token이나 auth store는 Decision Plane의 입력·journal·상태 응답에 들어가지 않는다.

## 2026-09-21 실제 provider canary

실제 TypeSafe API를 106회 호출했다. intake 36회는 108개 라벨이 모두 맞았고 provider p50/p95는 252/347ms였다. row 40회는 모두 맞았고 233/295ms, adaptive 30회는 174개 라벨 중 `stuck` 1개가 틀렸고 provider p50/p95는 234/268ms였다. provider 호출은 실제지만 task와 정답은 통제 fixture이므로 evidence level은 fixture다.

초기 fit은 관측 precision 100%만 보고 작은 holdout을 live로 잘못 통과시켰다. 그 결과를 삭제하지 않고 실패 발견 근거로 보존했으며, Wilson 하한 gate 추가 뒤 모두 `shadow_only`로 재적합했다. 대표 하한은 intake route 0.701, row 0.806, adaptive target 0.610, value 0.342로 목표 0.90에 못 미친다. production profile 승격은 0건이다.

- `tests/evidence/decision-canary-2026-09-21T18-34-23-406Z/`
- `tests/evidence/decision-runtime-canary-2026-09-21T18-39-05-526Z/`
