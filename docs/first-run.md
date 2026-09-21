# 첫 실행: 내 컴퓨터 연결

Agent Driver의 설치 경험은 사용자가 Pack, registry, GitHub 경로, MCP 설정 파일을 이해하도록 요구하지 않는다. 사용자는 설치를 담당하는 에이전트에게 다음처럼 한 번만 말하면 된다.

> Agent Driver를 설치하고, 앞으로 컴퓨터·브라우저 작업은 Agent Driver로 해줘.

기본 agent runtime은 Hermes다. 설치 에이전트는 Agent Driver를 설치한 뒤 `agent-driver hermes configure`로 Hermes의 MCP client에 공통 stdio 서버를 등록한다. Telegram 대화·장기 기억·계획은 Hermes가, 외부 효과·lease·승인·검증은 Agent Driver가 맡는다. Codex·Claude·Cursor도 동일한 `agent-driver mcp` 명령으로 직접 연결할 수 있으며 vendor별 adapter나 registry는 없다.

사용자가 직접 보는 절차는 두 단계뿐이다.

1. 설치를 지시한다.
2. `agent-driver connect`가 연 loopback 로컬 화면에서 **이 컴퓨터 연결**을 승인한다. Telegram을 쓸 때는 Hermes가 안내하는 bot 연결에서 token과 허용 사용자만 한 번 입력한다.

## 연결 화면

현재 제공되는 승인 선택지는 **방해하지 않는 모드** 하나다. 사용자 desktop, 탭, foreground, clipboard는 공유하거나 제어하지 않고, 지속형 전용 Agent Computer의 browser surface만 사용한다.

- **방해하지 않는 모드**: 현재 사용 가능하며 기본값이다.
- **에이전트 전용 데스크톱**: Windows guest/UIA가 실구현되기 전까지 준비 중으로 표시한다.
- **공유 화면 허용**: 제공하지 않는다. 사용자 desktop 제어는 제품 권한 범위 밖이다.

승인 뒤에는 사용자 홈의 `~/.agent-driver`(또는 `AGENT_DRIVER_CONNECTION_ROOT`)에 private connection state와 MCP용 runtime config가 생성된다. 실행 명령은 항상 `agent-driver mcp`다. Hermes 연결은 `agent-driver hermes configure`, 상태 확인은 `agent-driver hermes doctor`다. 로그인, 전용 브라우저 VM 준비, Jev 연결은 해당 작업이 실제로 요구할 때만 안내한다. 자세한 권한 경계는 [Hermes + Telegram runtime](hermes-telegram-runtime.md)을 따른다.

## 상태의 의미

`MCP 명령 준비됨`은 클라이언트가 공통 stdio 명령을 등록할 준비가 됐다는 뜻이지 실제 Telegram task 성공을 뜻하지 않는다. `Hermes: 기본 Agent runtime`은 대화와 계획의 소유자를 뜻한다. `Telegram`은 Hermes gateway의 입출력/사람 개입 채널이다. `Browser`는 첫 브라우저 작업에서 전용 환경을 준비하며 host Chrome을 대신 사용하지 않는다. `Jev: 선택사항`은 API key를 설치 시점에 요구하지 않는다는 뜻이다.
