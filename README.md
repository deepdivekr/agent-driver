# agent-driver

에이전트의 브라우저·코딩 CLI 업무를 실행하고 **소유권·중단·복구·완료 증거**를 관리하는 실행 control plane입니다. 사용자의 작업을 방해하지 않는 실행 환경을 목표로 개발합니다.

현재는 **실험적 MVP 구현 단계**입니다. SQLite 실행 기록, 소유권/fencing, 이벤트 재전달, 자체 앱의 headless 브라우저 저장·재조회, Claude 구조화 세션과 명시적으로 위임된 파일 작업을 구현하고 있습니다. 범용 사이트·일반 프로젝트 빌드·Windows 무간섭을 인증한 제품은 아닙니다.

## 바로 실행

Linux 또는 Ubuntu/WSL의 Bash에서 실행합니다. Node **22.22.0**, npm **11.11.0**을 사용합니다. 이 버전의 내장 SQLite는 experimental 경고를 stderr에 출력할 수 있습니다.

```bash
git clone --branch phase-26-soak https://github.com/deepdivekr/agent-driver.git
cd agent-driver
npm ci
npx playwright install chromium
npm run build
npm run runtime -- demo
```

위 명령은 아직 merge되지 않은 독립 soak 보강 브랜치를 받습니다. merge 이후에는 `--branch phase-26-soak`를 생략할 수 있습니다. 브라우저 Linux 시스템 의존성이 없는 환경은 설치 관리자 권한이 필요한 `npx playwright install --with-deps chromium`을 사용합니다.

복구 재진입은 [세대별 단계·실패 기록](docs/supervisor-recovery.md)으로 추적합니다. [간헐 재개 실패 #22](https://github.com/deepdivekr/agent-driver/issues/22)는 아직 원인 미확정이며 공식 출시 gate로 유지합니다.

대량 CLI 출력 중 제어 요청의 응답성과 유한 부하 관측 방법은 [출력·제어 계약](docs/output-control.md)에 있습니다. 장기 운영·Windows 무간섭 인증과는 구분합니다.

독립적인 유한 시간 반복 시험은 [soak 실행·관측 안내](docs/soak.md)를 참고하세요. 같은 DB와 전용 프로필에서 실제 브라우저·합성 CLI를 시험하며, 모델이나 실계정 사이트는 호출하지 않습니다. alpha.12의 fresh public 설치는 2시간 smoke(1,056 cycles, 실패·중복 효과·중복 CLI receipt 모두 0)를 통과했지만, 실제 모델·실사이트·Windows 무간섭 또는 72시간 이상 운영 인증은 아닙니다.

`demo`는 새 전용 프로필과 loopback 테스트 앱만 사용합니다. 기존 Chrome에 연결하지 않고 외부 사이트에 쓰지 않으며 모델 API를 호출하지 않습니다. 결과의 `task_id`와 `project_id`로 상태/이벤트를 조회할 수 있습니다. `.runtime/`에는 로컬 DB와 전용 프로필이 남고 공개되지 않습니다.

```bash
cd agent-driver
npm run runtime -- status --task TASK_ID
npm run runtime -- events --project PROJECT_ID --consumer my-agent
npm run runtime -- ack --project PROJECT_ID --consumer my-agent --event EVENT_ID
```

위 `TASK_ID`, `PROJECT_ID`, `EVENT_ID`는 실제 출력값으로 바꿉니다. 이미 저장소 안에 있다면 중복으로 `cd agent-driver`하지 않습니다.

## 실패/복구 확인

저장 이후 응답만 잃은 경우에도 readback이 일치하면 완료합니다. 저장 이전에 응답을 잃고 결과가 일치하지 않으면 보수적으로 중단하며 자동 재저장하지 않습니다.

```bash
cd agent-driver
npm run runtime -- demo --fault after
npm run runtime -- demo --fault before
npm run runtime -- demo --wrong-account true
```

`before`와 오계정 사례의 종료 코드 2는 예상된 미완료/차단입니다. `recover --task TASK_ID`는 기록을 분류할 뿐 외부 명령을 재전송하지 않습니다. 아직 실행 전인 작업의 `cancel`은 발송을 막지만 이미 발생한 외부 효과를 되돌리지는 않습니다.

## 구현/검증 상태

|범위|상태|
|---|---|
|SQLite WAL/FULL·intent 선기록·단일 writer·fencing|구현·로컬 검증|
|응답/독립 검증 분리·불명확 쓰기 중단|구현·실제 테스트 앱 검증|
|project별 이벤트 fetch/ack 재전달|구현·재오픈 검증|
|프로세스 강제 종료 뒤 intent 보존|실제 child kill 검증; 전원 상실 인증 아님|
|Jev calibration 후보|평가 완료, shadow-only; 실행 권한 없음|
|stdio MCP·공통 CLI·요청 ID dedup·gateway와 별도 worker|합성 앱에서 구현·검증; 미구현 도구는 명시적 오류|
|독립 감독자·worker 사망 복구·읽기 전용 재조정|Linux 동일 부팅의 합성 앱에서 구현; OS watchdog/Windows/재부팅 복구는 미완료|
|한 줄 요청→출처 있는 인수 제안|intake 연결; 범용 자연어 이해/실제 Task Pack은 후속|
|독립 CLI host·명시적 세션/턴·중복 방지·재개|Linux 구조화 통신·실제 CLI 검증; 대화형/native ConPTY 후속|
|정확한 경로 위임·파일 broker·쓰기 intent/readback|Linux 전용, 독점 작업 사본만 지원; 기본 CLI 도구/shell은 닫음|
|독립 Node 입출력/종료 계약 검증|bubblewrap 격리 snapshot과 고정 oracle; 일반 프로젝트 테스트 runner 아님|
|합산 CPU·메모리·PID 경계|명시적 host 설정·Linux user systemd/cgroupv2; kernel readback과 자손 회수 검증. 예산 미설정은 unverified|
|저장 예산·분할 로그·보존 만료 사본 정리|host 정책·프로세스별 예약·실제 ENOSPC·정리 중단 복구 시험; 애플리케이션 admission이며 hard disk quota 아님|
|일관된 WAL 백업·새 경로 격리 복원|운영자 CLI·artifact hash·중단/no-replay 검증; [정상 업무 재개와는 구분](docs/backup-restore.md)|
|과거 턴·정규화 출력 조회·실제 Git 인계|세션 범위·변경/변조 확인; 프로젝트 테스트 실행·완료 판정은 하지 않음|
|다중 executor 자동 takeover|후속 구현|
|Windows foreground 비간섭·guest 설치·soak|미검증/후속 구현|

상세 설계는 [v0.7](docs/control-plane-design-v0.7.md), 평가 근거는 [평가 요약](docs/evaluation-summary.md), 공개 범위는 [PUBLICATION.md](PUBLICATION.md)를 참고하세요. 프로세스 내부의 신뢰된 adapter 코드는 보안 샌드박스가 아니며, 동일 OS 사용자 권한으로 DB를 바꿀 수 있는 공격자를 막는다는 보장은 없습니다.

에이전트 연결과 합성 앱 실습은 [Agent interface](docs/agent-interface.md), 브라우저 복구는 [감독자 안내](docs/supervisor-recovery.md), CLI는 [adapter 안내](docs/cli-adapter-matrix.md), 기록 수집은 [조회·인계](docs/terminal-handoff.md), 파일 위임과 테스트는 [파일 작업 계약](docs/terminal-file-effects.md), 저장 관리는 [예산·보존 안내](docs/storage-boundaries.md)에 있습니다. MCP 이름30개를 노출하며 browser session 계열은 아직 미구현입니다. production 기본값에서 테스트 쓰기와 CLI 경로는 비활성화되며 CLI·파일 위임은 별도 host 설정이 필요합니다.

## 검사와 프로젝트 관리

```bash
cd agent-driver
npm test
```

테스트는 외부 모델 API나 실제 사용자 사이트를 사용하지 않습니다. 각 결과에 `evidence_level`과 `status`를 별도로 기록하며 `tests/report.json`과 `tests/evidence/`에 누적합니다. 이 생성 기록은 기본 커밋 대상이 아닙니다.

파일 검증 시험에는 Linux user namespace·bubblewrap·util-linux가 필요합니다. Ubuntu24.04 Bash에서 저장소로 이동한 뒤 `sudo apt-get install bubblewrap util-linux`로 의존성을 설치할 수 있습니다. 자원 검사는 활성 user systemd255·cgroupv2 cpu/memory/pids도 필요합니다. 격리 실행을 허용하지 않는 환경은 명시적으로 실패/차단하며 비격리·무제한 실행으로 대체하지 않습니다. [자원 경계 설정과 한계](docs/resource-boundaries.md)를 참고하세요. 강한 보안/DoS·디스크/I/O·gateway 전체 예산은 여전히 출시 gate입니다.

- [로드맵 #1](https://github.com/deepdivekr/agent-driver/issues/1)
- [현재 구현 #2](https://github.com/deepdivekr/agent-driver/issues/2)
- [입력/MCP #3](https://github.com/deepdivekr/agent-driver/issues/3)
- [브라우저/인계 #4](https://github.com/deepdivekr/agent-driver/issues/4)
- [CLI host #5](https://github.com/deepdivekr/agent-driver/issues/5)
- [출시 조건 #6](https://github.com/deepdivekr/agent-driver/issues/6)
- [자원 경계 #14](https://github.com/deepdivekr/agent-driver/issues/14)
- [저장 경계 #16](https://github.com/deepdivekr/agent-driver/issues/16)

코드 변경은 검증 근거가 있는 PR로 관리합니다. 공개 저장소이지만 배포 라이선스는 아직 결정하지 않았습니다.
