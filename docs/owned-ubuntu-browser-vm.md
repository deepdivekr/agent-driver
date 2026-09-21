# 전용 Ubuntu browser VM (experimental)

이 경로는 BrowserOS Neo·사용자 Chrome·사용자 desktop을 실행 대상으로 쓰지 않는다. `agent-driver`가 만든 QEMU/KVM guest 하나와 그 guest의 Chromium profile만 브라우저 작업에 사용한다.

## 흐름

```text
orchestrator/MCP
  -> agent-driver policy · approval · journal
  -> Playwright over 127.0.0.1:<devtools port>
  -> QEMU host-loopback forward
  -> Ubuntu guest Chromium persistent profile
```

guest는 `Xvfb + Openbox + Chromium + x11vnc`를 시작한다. 사람의 사이트 로그인은 필요할 때에만 guest VNC 화면에 직접 수행한다. 그 뒤 task마다 agent-driver가 새 guest page를 만들며, 인증 cookie는 같은 **guest profile** 안에서만 재사용한다. 사용자 OS의 탭·창·키보드·클립보드는 runtime이 사용하지 않는다.

## 기본 경계

- VM disk·cloud-init·capture root는 agent-driver가 소유한 0700 경로에만 만든다.
- base image SHA-256이 명시적으로 일치하지 않으면 overlay를 만들지 않는다.
- KVM, `qemu-system-x86_64`, `qemu-img`, `cloud-localds` 중 하나라도 없으면 host browser로 폴백하지 않고 `VM_BACKEND_UNAVAILABLE`으로 멈춘다.
- QEMU command에는 shared folder, `-virtfs`, `-fsdev`, public bind가 없다. DevTools·VNC·유지보수 포트는 `127.0.0.1`으로만 forward한다.
- Playwright CDP bridge는 지정된 guest VM의 loopback debug port만 연결한다. 사용자 브라우저 탐색·attach는 구현하지 않는다.
- 사이트 credential, cookie, approval token은 VM manifest·cloud-init·runtime log에 쓰지 않는다.
- 정상 상태의 반복 확인은 이전 `gate + state_fingerprint`와 같으면 화면 캡처를 생략한다. 상태 전환, `waiting_orchestrator`, 그리고 제출 직전은 반드시 캡처한다.

`node dist/cli.js vm doctor`는 설치·권한 상태만 읽는다. `vm provision`은 별도 image 인자가 없으면 agent-driver가 고정한 Ubuntu 24.04 amd64 cloud image를 다운로드하고 SHA-256을 확인한 뒤 VM 파일을 만든다. custom image는 경로와 SHA-256을 함께 줘야 한다. `vm launch`는 그 VM만 시작한다. BrowserOS Neo는 어느 단계에도 없다.

기본 image의 URL·해시는 Ubuntu의 [Noble cloud image SHA256SUMS](https://cloud-images.ubuntu.com/noble/current/SHA256SUMS)에서 2026-09-21에 고정했다. 현재 image와 다르면 부팅하지 않고 제품 업데이트로 검토·갱신해야 한다.

## 현재 보장과 한계

이것은 **작업 환경 격리**다. shared folder와 사용자 UI 간섭을 없애지만, 악성 guest 탈출·동일 호스트 사용자·QEMU/브라우저 취약점까지 막는 고보안 sandbox라고 주장하지 않는다. 고위험 사이트에는 별도 물리 host 또는 별도 보안 VM, egress proxy/allowlist, 업데이트된 guest image가 필요하다.

이 host에서는 current-user KVM 권한과 QEMU 도구를 확인했고, agent-driver 전용 Ubuntu guest의 Chromium/CDP 연결과 Stack & Sky 로그인 게이트까지 읽기 전용으로 관측했다. 이는 폼 경로·독립 readback·외부 제출이 검증됐다는 뜻이 아니다. 최초 인증과 그 뒤의 폼 관측은 계속 별도 gate다.
