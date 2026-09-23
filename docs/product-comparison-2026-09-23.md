# Agent computer 제품 비교 — 2026-09-23

## 공식 제품이 말하는 범위

Meta Muse는 사람별 `Muse Secure VM` 안에 에이전트와 데이터를 두고, 앱이나 WhatsApp 대화로 일을 맡기며 앱을 닫아도 계속 실행한다. 장기 목표를 계획하고 대화에서 선호를 기억하며, 이메일 전송이나 구매처럼 외부 효과가 생기기 전 승인을 요청한다. 출처: [Meta Newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/).

Grok Bot은 bot마다 클라우드 컴퓨터를 제공하고 웹·앱·받은편지함에서 24시간 작업한다. 데스크톱과 휴대전화에서 메시지로 일을 맡기며 대화와 선호를 기억한다. 여러 bot을 병렬로 두고 상위 bot이 조정하거나 bot끼리 thread context를 공유하는 팀 모델도 제품 기능으로 제시한다. 출처: [xAI — Introducing Grok Bot](https://x.ai/news/introducing-grok-bot).

## Agent Driver와 다른 점

| 항목 | Muse / Grok Bot | Agent Driver |
|---|---|---|
| 제공 형태 | 공급자가 운영하는 앱과 클라우드 컴퓨터 | 사용자가 설치하는 로컬 MCP runtime |
| 작업 입구 | 제품 자체 채팅, 모바일 앱·메신저 | Codex·Claude·Cursor·Hermes·Telegram 같은 외부 클라이언트 |
| 컴퓨터 | 공급자가 계속 켜 두는 개인별/봇별 클라우드 VM | 사용자 WSL/Linux runtime과 전용 browser/선택형 Ubuntu VM |
| 장기 실행 | 사용자의 PC가 꺼져도 공급자 클라우드에서 지속 | 로컬 호스트가 켜져 있어야 지속. 클라우드 worker는 별도 배치가 필요 |
| 기억·개인화 | 제품이 대화·선호·목표 기억을 직접 제공 | 기본 대화 기억은 Hermes/호출 클라이언트가 소유하고 runtime은 task·evidence·recovery를 보존 |
| 다중 에이전트 | 제품이 bot 팀과 조정을 제공 | Swarm runtime이 worker lease·병렬 dispatch·activity를 제공하지만 실제 sub-agent 생성은 연결 클라이언트가 수행 |
| 실행 전략 | 화면 조작 중심으로 API/MCP 없는 앱도 포괄 | Playwright·browser surface·CLI·파일 executor와 MCP를 조합하고 Decision Plane이 LLM/Jev/code를 선택 |
| 승인 | 메일·구매 등에서 제품 승인 흐름 | effect별 승인·lease·재확인·중복 방지 계약 |
| 결제 | Muse는 agent checkout과 결제 보호까지 포함 | 결제·주문·예약 확정은 지원 범위 밖 |
| 데이터 경계 | 공급자 보안·개인정보 모델에 의존 | 로컬 저장과 전용 profile/VM을 사용하며 사용자가 실행 환경을 소유 |

핵심 차이는 VM 자체가 아니다. Muse와 Grok Bot은 **대화 입구, 기억, 항상 켜진 컴퓨터, 승인, 알림, 다중 에이전트 운영을 한 서비스로 묶은 제품**이다. Agent Driver는 그중 컴퓨터 실행과 복구·판단·증거 계층을 외부 에이전트에 제공하는 로컬 기반이다. 따라서 경쟁력은 VM 유무보다 어떤 클라이언트에서도 같은 작업을 이어가고, 반복 작업을 Pack으로 빠르게 만들며, 사용자가 실행 환경과 데이터를 소유한다는 점에 있다.

## 현재 따라잡아야 할 제품 구간

1. 저장소 설치 전부터 이어지는 네이티브 installer.
2. 클라이언트 설치 → 로그인 → MCP 등록을 끊김 없이 잇는 온보딩.
3. 관제센터 자체 Task Console과 결과 inbox.
4. 호스트가 꺼져도 실행되는 선택형 cloud worker.
5. 알림·승인·일정·장기 기억을 하나의 사용자 identity 아래 묶는 제품 계층.

Phase 58은 2번을 구현한다. 1·3·4·5는 현재 지원 범위를 넘어가므로 별도 phase가 필요하다.
