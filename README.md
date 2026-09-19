# agent-driver

에이전트의 브라우저·코딩 CLI 업무를 실행하고 **소유권·중단·복구·완료 증거**를 관리하는 실행 control plane입니다. 사용자의 작업을 방해하지 않는 실행 환경을 목표로 개발합니다.

현재는 **MVP 기반 구현 단계**입니다. 실제로 동작하는 범위는 SQLite 실행 기록, 소유권/fencing 검사, 이벤트 재전달, 자체 테스트 앱에서의 headless 브라우저 저장·독립 재조회입니다. 범용 사이트 지원이나 Windows 무간섭을 인증한 제품은 아닙니다.

## 바로 실행

Linux 또는 Ubuntu/WSL의 Bash에서 실행합니다. Node **22.22.0**, npm **11.11.0**을 사용합니다. 이 버전의 내장 SQLite는 experimental 경고를 stderr에 출력할 수 있습니다.

```bash
git clone --branch phase-15-runtime-foundation https://github.com/deepdivekr/agent-driver.git
cd agent-driver
npm ci
npx playwright install chromium
npm run build
npm run runtime -- demo
```

위 명령은 아직 merge되지 않은 첫 구현 브랜치를 받습니다. merge 이후에는 `--branch phase-15-runtime-foundation`을 생략할 수 있습니다. 브라우저 Linux 시스템 의존성이 없는 환경은 설치 관리자 권한이 필요한 `npx playwright install --with-deps chromium`을 사용합니다.

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
|자연어 한 줄·실제 Task Pack·MCP|후속 구현|
|다중 executor 자동 takeover·CLI host|후속 구현|
|Windows foreground 비간섭·guest 설치·soak|미검증/후속 구현|

상세 설계는 [v0.7](docs/control-plane-design-v0.7.md), 평가 근거는 [평가 요약](docs/evaluation-summary.md), 공개 범위는 [PUBLICATION.md](PUBLICATION.md)를 참고하세요. 프로세스 내부의 신뢰된 adapter 코드는 보안 샌드박스가 아니며, 동일 OS 사용자 권한으로 DB를 바꿀 수 있는 공격자를 막는다는 보장은 없습니다.

## 검사와 프로젝트 관리

```bash
cd agent-driver
npm test
```

테스트는 외부 모델 API나 실제 사용자 사이트를 사용하지 않습니다. 각 결과에 `evidence_level`과 `status`를 별도로 기록하며 `tests/report.json`과 `tests/evidence/`에 누적합니다. 이 생성 기록은 기본 커밋 대상이 아닙니다.

- [로드맵 #1](https://github.com/deepdivekr/agent-driver/issues/1)
- [현재 구현 #2](https://github.com/deepdivekr/agent-driver/issues/2)
- [입력/MCP #3](https://github.com/deepdivekr/agent-driver/issues/3)
- [브라우저/인계 #4](https://github.com/deepdivekr/agent-driver/issues/4)
- [CLI host #5](https://github.com/deepdivekr/agent-driver/issues/5)
- [출시 조건 #6](https://github.com/deepdivekr/agent-driver/issues/6)

코드 변경은 검증 근거가 있는 PR로 관리합니다. 공개 저장소이지만 배포 라이선스는 아직 결정하지 않았습니다.
