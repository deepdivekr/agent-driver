# 첫 실행: 설치 확인과 MCP 연결

Agent Office는 로컬 MCP 서버다. 에이전트에게 다음처럼 설치와 연결을 요청한다.

> github.com/deepdivekr/agent-office를 설치하고 MCP로 연결해줘. 앞으로 브라우저·파일 업무에 Agent Office를 사용해줘.

설치 에이전트가 Agent Office를 설치하고 `agent-office connect`를 실행하면 Agent Office의 로컬 온보딩이 열린다. 첫 화면은 설치 성공을 확인하고 Codex·Claude Code·OpenCode·Cursor·Hermes 중 사용할 클라이언트의 설치·로그인·MCP 등록을 안내한다. 연결 뒤에는 같은 화면의 업무 현황에서 단계별 진척·중단 이유·인계 기록을 확인한다. Hermes를 연결한 경우 Telegram 대화·장기 기억·계획은 Hermes가, 외부 효과·lease·승인·검증은 Agent Office가 맡는다.

직접 설치할 때는 Ubuntu/WSL 터미널에서 다음 한 줄을 실행한다.

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/deepdivekr/agent-office/v0.4.0/install.sh | bash'
```

bootstrap은 홈 디렉터리 안에 고정 Node/npm 런타임과 저장소를 준비하고, 의존성·빌드·Chromium·절대경로 launcher를 설치한 다음 `agent-office connect`를 실행한다. 기존 비관리 경로, symlink, 수정된 checkout은 덮어쓰지 않는다. 관제센터 주소가 터미널에 표시되고, 브라우저를 열 수 있는 환경에서는 화면도 자동으로 열린다. 이후 관제센터에서 client 설치·인증·MCP 등록·모델 설정을 이어간다.

사용자가 직접 보는 절차는 다음과 같다.

1. 설치를 지시한다.
2. `agent-office connect`가 표시한 로컬 화면에서 사용할 클라이언트를 선택한다. 없으면 **설치**를 누른다. 설치 확인 뒤 공식 로그인 화면으로 이어지며, 인증을 마치면 **MCP 연결**을 누른다. 이미 설치된 앱은 **로그인**부터 진행한다.
3. **로컬 실행 승인** 뒤 AI 연결과 선택적 Jev를 설정한다. Telegram을 쓸 때는 Hermes가 안내하는 bot 연결에서 token과 허용 사용자만 한 번 입력한다.

## 연결 화면

화면 상단의 **다크 모드 / 라이트 모드** 버튼으로 테마를 바꾼다. 처음에는 기기 설정을 따르고, 직접 선택한 테마는 같은 브라우저에 저장된다. 전환해도 작성 중인 입력이나 업무 실행은 바뀌지 않는다.

연결 화면은 관제센터의 **연결 및 설정**이다. **에이전트 → 로컬 실행 → AI → Jev**를 한 화면씩 설정한다. 화면 하단의 **연결 작업 기록**은 이 화면에서 실행한 설치·등록·연결의 시작과 결과를 보여준다. 터미널 출력이나 업무 실행 로그가 아니다. 실제 업무 진행 기록은 **업무 현황 → 업무 상세**에서 본다. 키와 CLI 원문 출력은 기록하지 않는다. 사이트 로그인은 온보딩에 포함하지 않는다. Task가 인증이 필요한 URL을 실제로 만났을 때 해당 worker를 멈추고 관제센터에 사이트별 로그인 요청을 표시한다. `connect`는 서버를 별도 프로세스로 유지하고 기존 연결을 재사용하며, MCP 재접속은 창을 다시 열지 않는다. [세부 동작과 지원 범위](control-settings.md).

기본 로컬 실행 승인은 **방해하지 않는 모드**다. 이 승인만으로 사용자 데스크톱·탭·클립보드 접근을 허용하지 않는다. Windows 네이티브 앱 제어와 선택 브라우저는 별도 실행기·권한·연결 확인이 필요하다.

- **방해하지 않는 모드**: 현재 사용 가능하며 기본값이다.
- **네이티브 Windows 앱 제어**: 실험 기능이다. 설치 즉시 모든 앱을 조작할 수 있는 것은 아니다.
- **Aside·Neo**: 별도 설치·로그인 후 관제센터에서 연결한다. 현재 어댑터는 조회 전용이며 VM 내부 연결은 미지원이다.

클라이언트 설치와 MCP 등록은 사용자가 각각의 버튼을 누른 뒤에만 실행한다. Linux/WSL 설치는 MCP가 실행되는 같은 환경에 진행한다. 공식 HTTPS 설치 원본과 확인된 공식 redirect만 허용하며, 다운로드는 30초·2 MiB로 제한한다. shell script가 아닌 응답은 실행하지 않는다. 임시 파일은 실행 후 삭제하고 raw installer 출력은 화면·journal에 보존하지 않는다. 이 검사는 원격 설치 프로그램의 내용 자체를 보증하거나 checksum을 고정하는 것은 아니다. 원격 프로그램 실행을 원하지 않으면 버튼을 누르지 않고 직접 설치해도 된다. Aside·Neo처럼 별도 앱 설치가 필요한 경우 **다운로드**는 공식 다운로드 페이지를 연다.

설치 뒤 지원되는 공식 CLI 로그인 흐름을 자동으로 시작한다. Cursor는 공식 브라우저 로그인, OpenCode는 ChatGPT 구독의 기기 코드 인증으로 연결한다. 인증 URL과 일회용 코드만 표시하고 token·credential store는 읽지 않는다. 로그인 완료는 CLI 상태를 다시 확인해서 판정한다. OpenCode의 기존 provider 종류는 인증 목록만으로 추측하지 않으며 API 선택은 AI 설정에서 명시적으로 진행한다.

실제 MCP 등록에는 절대 경로의 Node와 Agent Office CLI를 사용하므로 이후 작업 디렉터리에 의존하지 않는다. Codex·Claude Code는 공식 CLI 등록 명령, OpenCode는 사용자 전역 설정의 `mcp`, Cursor는 `mcpServers`, Hermes는 기존 YAML의 `mcp_servers.agent-driver`만 갱신한다. 같은 이름의 다른 설정은 덮어쓰지 않는다. 현재 OpenCode의 주석 포함 JSONC는 자동 변경하지 않고 기존 파일을 보존한 채 검토를 요청한다. Windows 앱 연결, 저장된 키 관리, 업무 계획·이력, 연결 로그처럼 펼쳐 보는 항목은 파란 글자와 밑줄로 표시한다.

새 설치의 앱 경로는 `~/.local/share/agent-office`, 상태 경로는 `~/.agent-office`다. 기존 `~/.agent-driver`에 업무가 있으면 데이터를 옮기지 않고 그대로 이어 쓴다. `AGENT_OFFICE_CONNECTION_ROOT`로 다른 절대 경로를 지정할 수 있으며 이전 `AGENT_DRIVER_CONNECTION_ROOT`도 지원한다. 두 기본 경로 모두에 업무가 있으면 임의로 합치지 않고, 명시적인 경로 선택을 요구한다. 실행 명령은 `agent-office mcp`, 관제센터는 `agent-office connect`, Hermes 상태 확인은 `agent-office hermes doctor`다.

## 상태의 의미

저장소·패키지·기본 실행 명령은 `agent-office`다. 새 설치에는 `agent-driver` 호환용 별칭도 제공한다. 기존 launcher·개인 업무·MCP 등록 키·프로토콜 식별자는 임의로 교체하지 않는다. 구버전에서 바꾸려면 실행 중인 업무를 마치고 MCP·관제센터를 종료한 뒤 새 설치 명령을 실행하고 MCP를 다시 등록한다. v0.3.0 등 이전 태그와 배포 파일은 유지한다. [최신 화면 예시](../README.ko.md#화면으로-보기).

`MCP 등록됨`은 클라이언트 설정에 stdio 시작 명령이 저장됐다는 뜻이다. 이미 실행 중인 클라이언트는 재시작이나 MCP 새로고침이 필요할 수 있고, 실제 gateway 연결·Telegram task 성공과는 다르다. `Hermes: 기본 Agent runtime`은 대화와 계획의 소유자를 뜻한다. `Browser`는 첫 브라우저 작업에서 전용 환경을 준비하며 host Chrome을 대신 사용하지 않는다. `Jev: 선택사항`은 API key를 설치 시점에 요구하지 않는다는 뜻이다.
