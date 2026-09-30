# 커스텀 Pack 리팩토링 — 최종 진행 기록

Authority: [최종 계획서](custom-pack-refactoring-plan.md) and [AGENTS.md](../AGENTS.md).
Baseline: 0b11f1850a2afa846f191ce356aa4f486284b41f.
Initial implementation revision: 50fa080580e97ed8b2cf0fa51c20c67ef0607cf8.
Reviewed implementation revision: 0c6770a11f44f75c196c69c6b174e421245e72e2.
Delivery branch: refactor/custom-pack-reliability.

## 추가 검토 결과와 머지 권한

사용자는 미비점 재점검, 수정 커밋과 main 머지를 명시적으로 요청했다.
최신 main 7efc862를 확인했고 충돌은 없었다. 독립 검토로 아래 결함을
재현해 548ab75와 0c6770a에서 보완했다.

- 최대 길이 Pack 이름과 추가 사용자 지시를 복제할 때 지시 provenance가
  식별자 한도를 넘었다. 고정 길이 호스트 회차 ID를 사용하며 실제 원래
  목표 검증까지 통과하는 회귀 검사를 추가했다.
- 중단된 수동 Work의 감시 타이머가 조회를 계속했다. Work와 예약 부모의
  중단을 각 실행 경계에서 확인하고 완료된 관측을 보존해 같은 실행에서
  재개한다. 중단 5건의 대기열 점유와 메타데이터 유실의 우회도 막았다.
- 실패 후 같은 Pack이 복구돼도 고정 요청 재호출이 Work를 복구 불가능한
  상태로 만들었다. 완료된 쓰기 재실행 없이 새 상태 조회와 실제 출력 파일
  재읽기로 복구한다. 과거 실패는 그대로 남으며 원래 목표를 다시 검증한다.
  미복구는 재시도 가능한 review, 불명확한 효과는 reconciliation을 유지한다.
- 설치 검증의 이전 버전 fetch가 현재 공개 태그까지 자동 수집해 후보
  태그와 충돌했다. 필요한 태그만 가져오도록 --no-tags를 명시했다.

운영 범위도 명시했다. 관리되는 관제센터는 재시작 때 supervisor를 복구한다.
독립 MCP 프로세스는 실행/일정 활성화 때 supervisor를 켜며 status 조회만으로
자동 일정을 시작하지 않는다. 외부 도구 마켓플레이스와 개인 설치 교체,
새 release 발행은 이번 작업에 추가하지 않았다.

## 최종 수정본 검증

소스/테스트 revision은 0c6770a11f44f75c196c69c6b174e421245e72e2다. 후속 검증 문서 커밋은 제품 입력을
바꾸지 않는다. [공개 검증 기록](custom-pack-refactoring-validation.json)의
최상위가 이번 결과이고 previous_implementation_validation은 초기 기록이다.

| 검사 | 결과 |
|---|---|
| TypeScript build | PASS |
| 관련 회귀 / 복구·출력 / 최종 provenance 검사 | 185 / 71 / 10 PASS (중복 포함, 합산 금지) |
| Frozen quick | 1848 PASS / 0 FAIL / 12 BLOCKED_ENV / 1 NOT_RUN |
| 입력 무결성 | PASS, changed_paths=[] |
| 실제 신규 설치와 5개 이전 버전 업그레이드 | 6/6 PASS |
| ledger / public boundary / diff | PASS |

Quick 1861건에는 입력 무결성 1건이 포함된다. 실제 테스트는
1860건이며 1847건이 PASS다. Receipt는 runtime-tests-2026-09-30T23-47-54-634Z,
입력 manifest SHA256은 14662fd26dc15cc715b0b83f59168057448f86e589123e37be60fc7f52ba9284다.
설치 receipt는 2026-09-30T23-48-33.255Z이며 모든 설치 SHA가 위 revision과
일치한다. 실제 npm ci/build, Chromium, MCP, Work/모델 설정 보존과 UI/font를
검사했다. 업무 모델은 fixture이고 외부 모델 호출은 0이다.

548ab75의 첫 추가 quick은 1847 PASS / 1 FAIL / 12 BLOCKED_ENV / 1 NOT_RUN이었다.
상태 조회에만 새 request_id가 추가돼 실행 관측과의 동일성 검사에 실패했다.
양쪽에 같은 실제 Pack 요청 ID를 기록하도록 고쳤고 기존 동일성 oracle을
유지했다. 최초 실패 receipt와 548ab75 설치 6/6 PASS 기록은 보존한다.

로컬 환경의 systemd/cgroup 11건, proc children 1건, graphical display 1건은
아래에 설명한 기존 환경 제한이다. 원래 비공개 23건은 재실행하지 않았고
Phase112 기록을 성공으로 소급하지 않았다. 초기 공개 USGS 관측도 아래
초기 revision의 기술 검증이며 이번에 다시 수행한 것으로 표시하지 않는다.

## 초기 구현과 검증 기록 (50fa080)

아래는 초기 구현 50fa080 당시의 기록이다. 당시 R0–R5의 구현과 사용 가능한
검증을 완료했고 후속 04eab8f는 검증 문서만 추가했다. 이번 추가 수정과
최종 결과는 위의 0c6770a 검증을 기준으로 한다.

- R0: 최종 계획서, 진행 기록, 매 압축/재개 후 복귀 규칙을 저장했다.
- R1: 읽기/수정 필드 분리, 비대상 보존, 명시적 숫자 정규화, 선언 필드
  preflight, 실제 TXT/JSON/CSV 저장·재읽기를 구현했다.
- R2: typed artifact/watch 검사와 독립적인 원래 사용자 목표 검증을 연결했다.
  전체 관측 행 수가 변하는 업무와 정확한 고정 행 수 요구를 구분한다.
- R3: 제한된 안전 조회 보정, 고정 요청의 원래 성공 영수증 재사용,
  host가 입증하는 정상 Swarm 상태 전이를 구현했다. 쓰기/불명확한 효과는
  재실행하지 않으며 과거 실패 기록을 보존한다.
- R4: 검증된 단일 recipe와 원래 Work 계약의 불변 버전, 새 수동 회차,
  기존 WorkSchedules를 통한 자동 새 회차를 구현했다. 실패 회차는 같은
  실행에서 복구한다. 부모 제어·계약 변경·메타데이터 유실을 검사하고,
  손상된 회차만 보류한다. 상태에 해당 child Work/run을 연결한다.
- R5: 빌드, 집중 검사, frozen quick suite, 입력 무결성, ledger,
  public boundary와 실제 공개 HTTP 검증을 수행했다.

외부 도구 마켓플레이스, 새 DB/큐/실행 엔진은 추가하지 않았다.
벤치마킹은 계획서의 고정 revision과 원칙을 적용했으며 외부 코드를 복사하지
않았다. 개인 설치와 기존 비공개 실사용 DB는 변경하지 않았다.

## 초기 구현 검증 (50fa080)

환경: Node22.22.0, npm11.11.0, Chromium153. package manifests 변경 없음.

| 검사 | 결과 |
|---|---|
| TypeScript build | PASS |
| Custom Pack/native/schedule 집중 검사 | 51 PASS |
| 최종 frozen quick suite | 1833 PASS / 0 FAIL / 12 BLOCKED_ENV / 1 NOT_RUN |
| 입력 무결성 | PASS, changed_paths=[] |
| ledger | PASS, 196 RQ |
| public boundary / git diff check | PASS |
| USGS 실제 공개 HTTP 관측 2회 | PASS |

Quick의 1846건에는 입력 무결성 1건이 포함된다. 실제 테스트는 1845건이고
그중 1832건이 PASS다. 최종 receipt는
runtime-tests-2026-09-30T21-41-42-030Z이며 입력 manifest SHA256은
e5b737872fa4428ad834efc0c8922443d2bd917a695b356df0af95f24bde65db다.
원본 상세 receipt는 실행 환경의 ignored tests/evidence에 남는다.
공개 JSON 기록은 개인 receipt나 자격 증명을 포함하지 않는다.

실제 USGS 검증은 2026-09-30T21:23:44Z 초기 구현 빌드에서 수행했다.
두 관측 각각 13행을 명시적으로 숫자 정규화하고 정확한 JSON bytes/hash와
native proof를 확인했다. 새 회차는 별도 run/artifact/관측 시점을 사용했고,
같은 회차 재호출은 중복 실행 없이 기존 결과를 반환했다. 모델 호출0,
외부 쓰기0이다. 이는 실제 공개 수집의 기술 검증이며 비공개 Work 목표의
실사용 수용 검증은 아니다.

## 환경 제한과 최초 실패 기록

최초 frozen quick은 1832 PASS / 13 FAIL / 1 NOT_RUN이었다. 입력 무결성은
PASS였다. baseline 0b11f18의 세 테스트 파일을 같은 환경에서 별도로 실행해
31건 중 18 PASS / 동일한 이름의 13 FAIL을 확인했다.

- 자원 격리 11건: 실제 systemd 사용자 관리자/bus와 위임된 cgroup v2가
  없다. 실제 호스트 전제조건이 없어 BLOCKED_ENV로 기록했다.
- verifier 부모 종료 1건: 살아 있는 프로세스에도 proc children interface가
  없다. 커널의 CONFIG_PROC_CHILDREN/CONFIG_CHECKPOINT_RESTORE가 꺼져 있다.
  자식 종료 검사를 실행하지 않았으므로 BLOCKED_ENV다.
- 설정 UI 1건: fixture가 실제 Codex 계정 모델 목록에 의존했다. 모델 목록을
  fixture로 고정했다. 기존 저장 검증·provider probe·키 마스킹·실제 화면
  조작을 유지한 데스크톱/모바일 검사가 PASS했다.
- headed 저장 profile 1건: graphical display가 없어 NOT_RUN이다.

지원 호스트의 기존 자원/종료 oracle과 제품 권한 검사는 그대로 유지했다.
전제조건이 확인된 뒤 발생하는 오류나 assertion failure를 skip하지 않는다.
최초 실패 receipt는 그대로 보존하며 PASS로 바꾸지 않았다.

## 실사용 수용 검증의 한계

사용자가 제공한 23건의 원래 DB, receipts, 계정과 실행 환경은 이 checkout에
없다. 이를 재실행하거나 모두 해결됐다고 판정하지 않았다. 계획서의 사례별
수용 기준과 기존 Phase112 결과 PASS0/FAIL23/NOT_RUN1을 유지한다.
특히 금지 행동 부재·원본 근거 부족·불명확한 효과·사용자 중단은 완료로
소급하지 않는다. Fixture PASS는 해당 실제 업무의 PASS를 대신하지 않는다.
## 압축/재개 후 다음 행동

1. AGENTS.md, 최종 계획서와 이 기록을 읽고 git 상태/원격 revision을 대조한다.
   제품 방향은 구체적인 사용자 소유 반복 업무의 관제센터다.
2. 구현과 로컬 검증은 끝났다. 전달 브랜치의 검증 문서 커밋과 push를 확인하고,
   필수 runtime CI가 통과한 PR을 승인된 main에 머지한다. main이 이미 전달
   HEAD를 포함한다면 머지도 완료된 것이다. PR/runtime 규칙은 우회하지 않는다.
3. 지원 호스트 및 비공개 사례의 남은 한계를 유지한다. 개인 설치/공개 태그를
   바꾸거나 과거 Work를 완료로 소급하지 않는다. 새 마켓플레이스 작업으로
   범위를 넓히지 않는다.
