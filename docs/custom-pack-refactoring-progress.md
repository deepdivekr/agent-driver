# 커스텀 Pack 리팩토링 — 최종 진행 기록

Authority: [최종 계획서](custom-pack-refactoring-plan.md) and [AGENTS.md](../AGENTS.md).
Baseline: 0b11f1850a2afa846f191ce356aa4f486284b41f.
Implementation revision: 50fa080580e97ed8b2cf0fa51c20c67ef0607cf8.
Delivery branch: refactor/custom-pack-reliability.

## 사용자 요청에 따른 추가 검토·머지 체크포인트

사용자는 추가 미비점 점검, 수정 커밋과 main 머지를 명시적으로 요청했다.
원격 main은 7efc862, 검토 출발점은 04eab8f다. 아래 기존 최종 검증은
50fa080 구현의 기록이며, 이번 수정의 검증 결과로 소급하지 않는다.

수정한 재현 결함(전체 검증·머지는 아직 진행 중):

- 최대 80자 Pack key와 추가 사용자 지시를 복제할 때 지시 provenance ID가
  검증기 한도를 넘는다. 고정 길이 호스트 회차 ID로 바꾸고 목표 검증까지
  실행하는 통합 회귀 검사를 추가했다. 기존 빌드에서 실패를 재현했다.
- 일시정지한 수동 커스텀 Work의 감시 타이머가 HTTP 관측을 계속한다.
  타이머와 진행 중 실행 경계에서 중단·부모 권한을 확인하고, 일시정지는
  불변 계약 손상과 구분해 같은 실행에서 재개한다. 중단된 5개 회차가 정상
  타이머 작업을 가로막지 않으며, 메타데이터 유실에도 예약 슬롯을 검사한다.
- 원본 조회 실패 뒤 같은 Pack이 복구되어도 고정 요청 재호출을 영구적인
  reconciliation으로 처리한다. 과거 실패 기록과 효과 금지를 유지하면서
  복구된 실제 결과를 새 상태 조회로 관측한다. 그 새 증거 ID로 출력 파일을
  재읽고 bytes/hash를 검증한다. 복구 대기는 재시도 가능한 review로 남기며
  불명확한 효과는 기존 reconciliation을 유지한다.
- 원격 CI의 runtime 테스트는 1844 PASS / 1 BLOCKED_ENV / 1 NOT_RUN이었으나
  설치 검증이 실패했다. 이전 release tag fetch의 자동 tag 수집이 현재
  공개 v0.4.0까지 가져와 후보 태그와 충돌했다. 명시적 --no-tags로 수정했다.

다음 단위: 소스 변경을 동결하고 빌드·회귀·전체 quick·ledger를 검증한다.
그 뒤 기록을 갱신해 커밋/푸시하고 필수 runtime CI를 통과한 PR을 머지한다.
main 규칙은 PR과 runtime check를 요구한다. 규칙을 우회하거나 실패 검사를
PASS로 바꾸지 않는다. 개인 설치 교체와 새 release는 여전히 범위 밖이다.

추가 검토의 중간 검증: TypeScript build와 기존 관련 회귀 185건이 PASS했다.
감시·중단 회귀 10건도 PASS했다(185건에 포함되므로 합산하지 않는다).
실패 후 복구된 상태 receipt에서 실제 출력 파일을 재읽는 연결을 완료했다.
최종 build와 복구/identity/실행 도구/통합 회귀 71건이 PASS했다. 기존 185건과
겹치므로 수치를 합산하지 않는다. ledger 196 RQ, public boundary 758개 파일과
git diff check도 PASS했다. 이 소스/테스트를 동결하고 quick 및 설치를 검증한다.
관리되는 관제센터의 재시작은 기존 supervisor를 복구한다. 독립 MCP 프로세스는
실행/일정 활성화 때 supervisor를 켜므로 status 조회만으로 자동 일정을
시작하지 않는 기존 운영 범위도 운영 문서에 명시했다.

## 완료 상태

R0–R5의 구현과 사용 가능한 검증을 완료했다. 검증 기록을 추가하는 후속
커밋은 문서만 변경한다. 제품 소스와 테스트는 위 implementation revision에
고정돼 있다. [검증 수치·입력 해시](custom-pack-refactoring-validation.json)를
함께 확인한다.

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

## 최종 검증

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

실제 USGS 검증은 2026-09-30T21:23:44Z 최종 제품 빌드에서 수행했다.
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

1. AGENTS.md와 최종 계획서, 이 기록을 읽고 실제 git 상태/원격 revision을
   대조한다. 제품 방향은 구체적인 사용자 소유 반복 업무의 관제센터다.
2. 위 추가 검토·머지 체크포인트를 우선 확인한다. 실제 수정/테스트 상태를
   대조하고 남은 회귀 검증과 필수 CI, 승인된 main 머지를 마무리한다.
3. 남은 검증은 지원 커널/systemd/display 환경과 원래 비공개 사례에서
   수행해야 한다. 현재 환경을 지원 호스트로 위장하거나 과거 Work를
   성공으로 바꾸지 않는다. 새 마켓플레이스 작업으로 범위를 넓히지 않는다.
