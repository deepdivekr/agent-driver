# 승인형 Browser Task Pack runtime

Task Pack은 특정 사이트 자동화 스크립트가 아니라, 자연어 업무를 **관측 가능한 제안 → 사람이 결속해 승인한 한 번의 외부 write → 독립 readback**으로 바꾸는 adapter 계약이다.

## 책임 분리

| 계층 | 책임 | 할 수 없는 일 |
|---|---|---|
| Task Pack | 입력/시간 관계/popup/readback/approval 요구 선언 | core에 계정·cookie·site selector를 주입 |
| Jev | 낮은 지연의 구조화 후보 생성 | 실행 승인/제출 |
| LLM | Jev 후보가 provenance·도메인 검증에서 거절될 때 보정 | 검증 실패를 무시하고 draft 생성 |
| Browser adapter | agent 소유 profile에서 navigation·capture·정확한 click·readback | user tab/foreground/OS 입력 조작 |
| Approval channel | snapshot-bound token 전달과 정확한 `OK token` 검증 | 다른 task·수정된 화면·만료 token 승인 |
| Runtime store | proposal/hash/expiry/consume/intent/event 저장 | clear-text approval token 또는 credential 저장 |

## 안전한 한 건의 흐름

1. 자연어 원문과 source range를 검증한다. 누락·복수 업무·모호·지원 밖 값은 proposal을 만들지 않는다.
2. Jev를 먼저 실행한다. 결과가 도메인 검증에서 거절될 때만 LLM을 호출한다. 둘 다 거절되면 clarification이다.
3. 전용 browser adapter가 로그인 완료를 관측하고 알려진 안내 modal만 닫는다. auth/unknown/security modal은 hold다.
4. 채워진 form의 semantic snapshot과 pre-submit capture hash를 저장하고, 만료되는 단회 token을 승인 channel에 전달한다.
5. channel은 정확히 `OK <token>`만 확인한다. bare `OK`, 다른 task token, 화면 변경, 만료는 거절한다.
6. dispatch 직전에 token을 consume하고 command intent를 저장한다. 응답 유실/중단이면 재클릭하지 않고 independent readback 또는 reconciliation으로 간다.
7. readback이 정확히 일치할 때만 succeeded다.

## Pack 작성자가 제공할 것

- versioned manifest: 입력 필드, write effect, popup policy, 승인 binding, 시간 제약, readback 방식
- normalizer: 모든 입력을 원문 source range와 도메인 불변식으로 검증
- owned adapter: allowlisted origin, dedicated profile, `prepare/execute/verify/close`
- independent readback: UI 성공 문구가 아닌 서버/목록/상세의 별도 확인
- approval channel adapter: Runtime 밖에서 user identity와 token message를 검증

Reference operation-report Pack은 이 구조를 synthetic site에서 검증한다. 실제 Stack & Sky selector, 계정, Telegram credential은 core나 공개 문서에 포함하지 않는다.
