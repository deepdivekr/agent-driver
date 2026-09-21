# Windows Personal Agent Computer — 준비 계약

## 현재 상태

Windows native app을 사용하려면 사용자 Windows desktop이 아니라 별도 persistent Windows guest가 필요하다. Phase30은 그 guest의 image·network·UI Automation 경계를 구현하고 contract test로 검증했다. **Windows ISO, 라이선스, guest, UIA service가 아직 없으므로 실제 Windows 앱 실행은 `blocked_env`다.**

현재 Ubuntu Agent Computer가 제공하는 실제 surface는 여전히 browser뿐이다.

## 무엇을 막는가

- 사용자 host Windows의 창, 키보드, 마우스, clipboard, 저장된 비밀번호를 attach하거나 fallback으로 쓰지 않는다.
- ISO/product key를 다운로드하거나 저장하지 않는다. 사용자가 합법적으로 확보한 installer와 라이선스만 `owner_provided`으로 명시한다.
- installer ISO와 UEFI firmware는 절대 경로와 SHA-256이 모두 일치해야 한다. 누락·해시 불일치는 `ready=false`다.
- host↔guest 연결은 `127.0.0.1` loopback forward 두 개만 허용한다: guest-local UIA agent(guest 7443)와 소유자용 RDP(guest 3389).
- shared folder, host desktop mirror, OS input injection은 이 계약에 없다. 파일은 향후 명시적 import/export bridge로만 전달한다.

이것은 workload 격리다. 악성코드·커널 취약점까지 막는 강한 보안 경계로 과장하지 않는다.

## UI Automation 경계

guest 안의 향후 UIA service는 먼저 화면의 **control inventory**만 반환한다. inventory에는 control automation ID, 종류, visible/enabled, 짧은 label만 담기며 edit value, password, clipboard, screenshot, raw UI tree, 좌표는 거절한다.

그 다음 runtime은 같은 `capture_id`, 창 ID, control ID, control type을 묶은 `reviewed:true` invoke plan만 전송할 수 있다. 좌표 클릭·임의 text 입력·임의 shell/HTTP 명령은 이 API에 없다. action receipt도 request와 computer/task/capture/control 결속을 다시 확인한다.

따라서 Jev/LLM은 관찰된 후보 중 어떤 reviewed control이 업무 의미에 맞는지 판단할 수 있어도, 새로운 control·좌표·비밀값을 만들어 실행할 수 없다.

## 실제 활성화에 필요한 것

1. 사용자가 소유한 Windows installer ISO와 라이선스, 그리고 검증 가능한 SHA-256을 제공한다.
2. guest-local UIA service를 Windows guest 안에 설치하고 local port 7443에서 실행한다.
3. QEMU/KVM guest를 별도 persistent `PersonalAgentComputer`로 만들고 loopback forwards만 연결한다.
4. 실제 target app에서 observe → reviewed invoke → readback을 실행해 `user_environment` 증거를 추가한다.

이 네 단계가 끝나기 전에는 Windows desktop surface를 제품 기능으로 광고하거나 실제 실행 성공으로 기록하지 않는다.
