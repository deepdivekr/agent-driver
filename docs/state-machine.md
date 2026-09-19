# Phase 15 상태 전이

모든 전이는 task 변경과 append-only event/outbox를 같은 transaction으로 기록한다. 아래는 실제 구현된 전이이며 v0.5의 모든 상태별 운영 경로가 구현됐다는 선언이 아니다.

|from|event|to|조건|금지|
|---|---|---|---|---|
|없음|create|queued|등록 project·capability|미위임 capability|
|queued / ready_to_resume|acquire|running|단일 resource writer·새 generation|active/미조정 intent lease 강탈|
|running|begin|running|fencing 일치·취소 아님; intent 먼저 commit|stale/취소/동시 command|
|running|response|verifying|같은 intent/lease|응답만으로 succeeded|
|verifying / reconciliation_required|independent MATCH|succeeded|계정/target/generation·최신 readback|모델 confidence·UI 토스트를 완료 증거로 사용|
|verifying / reconciliation_required|NOT_MATCH / UNKNOWN|reconciliation_required|외부 효과 불명 유지|blind retry·writer 양도|
|running / queued|pre-dispatch error|paused_dependency|intent 없음|미확인 쓰기를 없던 일로 취급|
|비종료·미전송|cancel|cancelled|intent 없음|이후 실행|
|실행 중|cancel request|기존 상태 유지|cancel_requested 기록|이미 발생한 효과 rollback 주장|
|verifying|MATCH after cancel|cancelled|effect_state=observed 유지|effect_state=none으로 덮기|
|비종료|explicit recover|reconciliation_required|미확인 intent 있음|자동 재전송|
|비종료|explicit recover|ready_to_resume|intent 없음; 이전 lease 비활성화|다른 탭 추측 연결|
|종료|조회/취소/복구 요청|종료 유지|읽기/기존 결과|다시 실행|

waiting_auth/approval/orchestrator, rate_limited, suspended_environment/recovering 등의 상태 명칭은 계약에 예약돼 있지만 해당 workflow/adapter는 후속 구현이다. 프로세스 강제 종료는 시험하지만 실제 전원 차단/OS 재부팅은 별도 검증이다.
