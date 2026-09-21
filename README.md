# Agent Driver

**Agent Driver는 플러그인이나 클라우드 봇이 아니라, Hermes·Codex·Claude Code·Cursor 같은 에이전트가 전용 브라우저·CLI·파일 작업을 맡길 수 있도록 로컬에서 `agent-driver mcp`로 서빙되는 MCP 실행 서버(control plane)입니다.**

사용자는 에이전트에게 자연어로 일을 요청합니다. Agent Driver는 화면을 관측하고, 적절한 실행기와 판단기를 고르고, 사람의 승인이 필요한 지점에서 멈추고, 작업 뒤 결과를 다시 읽어 확인합니다. 성공한 흐름은 같은 종류의 다음 작업에서 재사용할 수 있는 Task Pack recipe가 됩니다.

> **현재 상태:** `v0.1.0-alpha.15` 공개 alpha입니다. Linux/WSL의 로컬 MCP·CLI, 8개 Pack family, durable recovery, 공통 Jev Decision Plane, agent-owned browser와 Ubuntu browser VM 경로를 구현·검증했습니다. 모든 사이트 자동 적응, production-calibrated 판단 profile, native Windows/macOS 데스크톱 제어, OS 상주 설치는 아직 완성된 기능이 아닙니다.

## 한눈에 보기

| 질문 | 답 |
|---|---|
| MCP인가요? | **예.** MCP 클라이언트가 로컬 stdio 명령 `agent-driver mcp`를 실행해 연결합니다. |
| 플러그인인가요? | **아니요.** 특정 에이전트에 종속된 플러그인이 아닙니다. MCP를 지원하는 클라이언트가 같은 서버를 사용합니다. |
| 별도 앱인가요? | 로컬 Node.js runtime과 CLI입니다. 연결 승인에는 loopback 전용 로컬 화면을 씁니다. |
| 클라우드 서비스인가요? | **아니요.** 실행 상태·SQLite DB·브라우저 profile은 기본적으로 이 컴퓨터에 남습니다. Jev를 켠 판단만 TypeSafe API를 호출합니다. |
| Hermes가 필수인가요? | **아니요.** 권장 상위 runtime입니다. Telegram 대화·계획·기억은 Hermes가, 실제 실행·승인·복구·검증은 Agent Driver가 맡습니다. 다른 MCP 클라이언트도 직접 연결할 수 있습니다. |
| Jev가 필수인가요? | **아니요.** 처음 설치할 때 필요하지 않습니다. 반복되는 짧은 판단에 이득이 있을 때 연결합니다. |

## 어떻게 돌아가나요?

```text
자연어 요청
  → Pack family와 허용된 효과 결정
  → 현재 화면·데이터를 새로 관측
  → 코드 / Jev / LLM 중 알맞은 판단 경로 선택
  → 전용 브라우저·CLI·파일·연결된 source에서 실행
  → 외부 변경 직전에는 사람에게 정확한 snapshot 승인 요청
  → 결과를 독립적으로 다시 읽어 성공 여부 확인
  → 검증된 recipe만 같은 환경의 다음 실행에 재사용
```

- **LLM**은 처음 보는 작업을 구조화하고, 첫 실행 명세를 만들고, 새로운 상태에서 재계획합니다.
- **Jev**는 코드가 만든 최신 state와 제한된 후보를 받아 상태·operation·target·관련성·완료·방해요소 같은 짧은 판단을 빠르게 반환합니다.
- **결정론적 코드**는 URL 허용 목록, 정확한 locator 실행, 날짜 계산, 파일 변환, 승인 token 검사, readback처럼 틀리면 안 되는 절차를 수행합니다.
- **executor**는 agent-owned browser, 격리된 CLI, bounded file pipeline 또는 선택형 personal VM입니다.

모델의 답은 제안이지 권한이 아닙니다. 실제 클릭·입력·제출 전에 runtime이 origin, candidate, freshness, effect boundary와 approval을 다시 검사합니다.

## 어떻게 서빙되나요?

기본 배포 형태는 이 컴퓨터에서 실행되는 **Node.js stdio MCP 서버**입니다.

```text
MCP client ──stdin/stdout──> agent-driver mcp
                               ├─ local SQLite state
                               ├─ owned browser / CLI / file executor
                               ├─ Task Pack runtime
                               └─ Decision Plane (Jev optional)
```

MCP client가 프로세스를 시작하고 표준입출력으로 도구를 호출합니다. 별도 public port나 중앙 Agent Driver cloud가 필요하지 않습니다. `agent-driver connect`만 최초 승인용 loopback 화면을 열며 외부 네트워크에 bind하지 않습니다.

Hermes를 쓰면 흐름은 `Telegram → Hermes → Agent Driver MCP → agent-owned computer`가 됩니다. Telegram 메시지, LLM 답변, Jev 결과만으로 제출 권한이 생기지는 않습니다.

## Pack family란?

Pack family는 특정 사이트용 매크로가 아니라, 비슷한 업무가 공유하는 **입력·관측·효과·승인·검증 계약**입니다. 사용자가 Pack JSON을 먼저 만들 필요는 없습니다. 자연어 요청은 `runtime_pack_plan`에서 family와 안전 경계로 구조화되고, 검증된 실행 recipe만 재사용됩니다.

| Family | 예시 | 현재 효과 경계 |
|---|---|---|
| `research.search` | 여러 출처 검색·비교·근거 포함 순위화 | 읽기 전용 |
| `portal.collect` | 로그인된 포털 조회·필터·내보내기 | 읽기 + 검증된 로컬 파일 |
| `form.draft-submit` | 양식 작성 후 제출 직전 검토 | 초안; 제출은 별도 승인 |
| `record.update` | 기존 레코드 수정 | 현재 snapshot 승인 + readback |
| `choose.stage` | 상품·옵션·후보 선택 후 장바구니/단계 저장 | 결제·예약·주문 확정 금지 |
| `inbox.triage` | 메시지 분류와 답장 초안 | 발송·삭제 금지 |
| `monitor.watch` | 가격·상태를 반복 확인하고 변경 중복 제거 | 로컬 이벤트; 외부 알림은 상위 runtime 담당 |
| `file.pipeline` | JSON/CSV 필터·변환·병합 | 원본 보존 + 새 파일 출력 |

Pack family 계약은 구현되어 있지만, 처음 보는 임의의 사이트가 한 번의 시도만으로 완전한 재사용 Pack이 되는 범용 자동 학습은 아직 실험적입니다. 자세한 내용은 [Pack catalog](docs/pack-catalog.md)와 [Pack runtime](docs/pack-family-runtime.md)을 참고하세요.

## Jev는 어느 단계에 들어오나요?

Jev는 브라우저를 직접 클릭하는 별도 executor가 아닙니다. 현재 페이지를 코드가 element table이나 JSON/text state로 만들고 후보를 제한한 **뒤**, 실행하기 **직전** Decision Plane에서 typed 판단을 담당합니다.

예를 들어 첫 실행에서 LLM이 `로그인됨 / 인증 대기 / 비밀번호 변경 안내 / 알 수 없음` 상태와 허용 동작을 정의하면, 이후 실행에서는 Jev가 최신 state에서 상태와 target을 빠르게 고릅니다. 선택된 locator의 실제 클릭, 입력, stale 검사와 결과 확인은 코드가 수행합니다. Jev가 낮은 확률을 내거나 후보가 맞지 않으면 재관측하고 LLM 또는 사람에게 넘깁니다.

이는 TypeSafe가 설명하는 System One 사용 방식—typed answer와 probability를 코드의 결정론적 검사와 결합하는 방식—을 따릅니다. [System One 개념](https://docs.typesafe.ai/concepts/system-one)과 [confidence 사용 지침](https://docs.typesafe.ai/confidence)도 참고하세요.

모든 Pack은 공통 Decision Plane을 사용합니다.

- 판단 ID와 위험도별 calibration profile
- 실제 동작을 바꾸지 않는 shadow provider 비교
- train/holdout 분리, 오답·불일치·지연 journal
- 저신뢰 `review/no_match`, LLM·사람 fallback
- operator만 가능한 profile promote/rollback

실제 TypeSafe provider canary에서는 106회 호출, catalog별 p50 233–252ms, adaptive `stuck` 오답 1건을 기록했습니다. 현재 생성된 profile은 모두 fixture `shadow_only`이며 **production profile 승격은 0건**입니다. 자세한 근거는 [Decision Plane](docs/decision-plane.md)과 [alpha.15 readiness](docs/release-readiness-alpha-15.md)에 있습니다.

## 필요한 환경

| 환경 | 현재 지원 수준 | 비고 |
|---|---|---|
| Ubuntu 24.04 / Linux x86_64 | **주 검증 환경** | Node CLI, stdio MCP, Linux PTY, owned browser, QEMU/KVM browser VM 경로 검증 |
| Windows 10/11 + WSL2 Ubuntu 24.04 | **지원·검증됨** | WSL 안에서 Agent Driver를 실행합니다. Windows host의 임의 앱을 직접 조작하는 native executor는 아직 아닙니다. |
| Windows native | **계약만 구현, 미지원** | Windows guest/UIA protocol은 있으나 production native desktop executor가 없습니다. |
| macOS | **미검증·미지원** | Node/stdio 호환 가능성만으로 지원을 주장하지 않습니다. native macOS desktop executor와 설치 검증이 없습니다. |

기본 설치에 필요한 것은 다음 두 버전입니다.

- Node.js `22.22.0`
- npm `11.11.0`

기능에 따라 선택적으로 필요합니다.

- browser 작업: Playwright Chromium (Ubuntu/WSL: `npx playwright install --with-deps chromium`)
- 전용 Ubuntu browser VM: Linux host의 KVM, `qemu-system-x86_64`, `qemu-img`, `cloud-localds`
- Telegram·장기 기억·대화 orchestration: Hermes
- 빠른 typed 판단: TypeSafe/Jev API key
- coding CLI 작업: 해당 CLI의 기존 설치와 로그인 상태

VM은 host의 Chrome·Windows 앱·clipboard·로그인을 그대로 공유하지 않는 별도 컴퓨터입니다. guest 안에 필요한 앱을 설치하고 로그인해야 합니다. 현재 Ubuntu VM에서 실제로 지원하는 surface는 browser이며, 이는 고보안 malware sandbox를 의미하지 않습니다. [Personal Agent Computer](docs/personal-agent-computer.md)와 [owned Ubuntu VM](docs/owned-ubuntu-browser-vm.md)에서 경계를 확인하세요.

## 설치

Ubuntu 24.04 또는 Windows의 WSL2 Ubuntu 터미널에서 실행합니다.

```bash
git clone https://github.com/deepdivekr/agent-driver.git
cd agent-driver
npm ci
npm run build
npx playwright install --with-deps chromium
npm test
npm link
agent-driver connect
```

로컬 화면에서 **이 컴퓨터 연결**을 승인한 뒤 MCP client에 아래 명령 하나를 등록합니다.

```text
agent-driver mcp
```

Hermes를 권장 상위 runtime으로 연결하려면:

```bash
agent-driver hermes configure
agent-driver hermes doctor
hermes mcp test agent-driver
```

Telegram token과 사용자 allowlist는 Hermes의 공식 `hermes gateway setup`에서만 입력합니다. Agent Driver는 bot token을 저장하지 않습니다. Jev도 첫 설치에서 강제하지 않으며, 실제 workflow가 typed 판단의 이득을 얻을 때 연결합니다. 자세한 최초 흐름은 [first-run UX](docs/first-run.md), 역할과 승인 경계는 [Hermes + Telegram runtime](docs/hermes-telegram-runtime.md)을 참고하세요.

## 안전 경계

- unknown, stale, low-confidence 상태를 성공으로 간주하지 않습니다.
- 외부 write는 현재 snapshot에 결속된 1회용 사람 승인이 필요합니다.
- 결제, 예약 확정, 주문 확정, 멤버십 가입, 이메일 발송·삭제는 현재 공개 경계 밖입니다.
- credential, browser profile, runtime DB와 evidence는 Git에 포함하지 않습니다.
- 사용자의 foreground Chrome이나 임의 프로세스를 종료하지 않습니다.

[Control-plane design](docs/control-plane-design-v0.7.md), [state machine](docs/state-machine.md), [evaluation summary](docs/evaluation-summary.md)에서 설계와 평가 근거를 볼 수 있습니다.

## 개발·검증

```bash
npm ci
npm run build
npm run test:runtime
```

테스트 보고서는 `PASS/FAIL`과 `unit/contract_fake/fixture_integration/native_integration/user_environment` 증거 수준을 분리합니다. fixture 통과를 실제 계정이나 native platform 성공으로 표시하지 않습니다.

## 라이선스

`main`이 최신 공개 source line입니다. 아직 오픈소스 라이선스를 선택하지 않았으므로 현재 저장소는 평가를 위한 source-visible 상태이며, 별도 재사용 권한을 부여하지 않습니다.
