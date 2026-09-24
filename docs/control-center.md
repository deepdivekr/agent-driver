# Agent Driver Control Center

Control Center는 Agent Driver가 맡은 업무의 진행 상태와 연결 설정을 보여주는 로컬 화면이다. 기본 화면은 **한 줄 업무 접수 → 업무함 → 업무 상세**이다. Browser/VNC 화면 wall과 실시간 미리보기는 없다.

```bash
agent-driver dashboard --config /absolute/path/to/host.json
```

서버는 `127.0.0.1`에만 열리고 매번 capability URL을 만든다. 온보딩·AI 연결·Jev·사이트 로그인 설정도 이 화면에서 처리한다. 사이트 로그인은 작업에 필요할 때만 표시된다.

## 확인할 수 있는 것

- 업무(Work), 실행(Run), 단계(Step)와 실제 저장된 계획·담당·활동·근거·결과
- 한 줄 업무의 영속 접수, 기본/심화 정의, 선택지 답변과 업무 조건 버전
- 단계별 진행 상태, 멈춘 이유, 누가 이어받았는지
- 최근 MCP heartbeat와 Browser/VM·CLI·Decision Plane 연결 상태
- 사람이 허용된 단계에 지침을 수정하거나 읽기 전용 Swarm 실행을 일시정지·재개하는 동작

화면은 Agent Driver에 보고된 작업만 표시한다. 다른 클라이언트가 직접 수행한 일을 자동으로 엿보지 않는다. `configured`는 실제 프로세스가 살아 있다는 뜻이 아니고, 검증 근거가 없는 정보는 `unobserved`로 남긴다. 저장하지 않은 모델의 내부 추론도 표시하지 않는다.

새 화면은 `work/board`의 최대 60개 요약을 한 공유 SSE로 갱신하고, 선택한 Work만 `work/detail`로 읽는다. Work 레코드마다 브라우저·VM·타이머를 만들지 않는다. `work/start`는 모델 호출 전 먼저 원문과 ID를 저장한다. 현재 관제센터는 Work를 접수·정의하고, 연결된 에이전트가 Pack/Swarm/코딩 단계를 배정한다. 등록된 로컬 Git 프로젝트의 코딩 Run은 Work와 결속해 단계별 상태를 표시한다. 일반 CLI 작업의 Work 결속, 장기 외부 대기 재개, Work 전체 완료조건의 독립 검증은 아직 제공하지 않는다.

## 화면 미리보기 제거

작업자별 브라우저 Page는 실제 작업에 계속 사용하지만 주기적 스크린샷을 찍거나 관제 화면에 보내지 않는다. 상태 snapshot의 `frame_path`는 항상 `null`이며 기존 `surface/:id/frame` 주소는 404를 반환한다. 과거 설정의 `frame_interval_ms`와 `observability.surfaces`는 호환성을 위해 읽지만 미리보기 수집을 켜지 않는다. 이는 모델이 별도 작업에서 명시적으로 요청한 단일 증거 캡처까지 금지한다는 뜻은 아니다.

## 화면 구성

agent-driver run trace 스토리보드와 같은 디자인 언어를 쓴다. 어두운 바탕에 mono 중심 라벨을 쓰고, 판단 경로마다 색을 하나씩 둔다. Jev·진행 중은 앰버, LLM은 라일락, 코드는 파랑, 사람은 로즈, 검증 완료는 초록이다. 사이드바에는 업무 보기(All·Needs you·Running·Queued·Verified), 가져오기, 사이트 로그인, 연결 및 설정을 둔다. 업무는 보드(기본)와 목록으로 볼 수 있고 제목으로 검색된다. 업무 상세는 run id·요청 줄·pack pill, 단계별 Run trace, 로즈 테두리의 Human control 패널로 구성된다. 긴 설명은 `?` 버튼의 모달로 연다. 외부 스크립트·폰트·이미지는 쓰지 않는다.

화면 언어는 영어가 기본이다. 우측 상단 국기 버튼으로 한국어로 바꾸며, 선택은 해당 브라우저의 localStorage(`office-lang`)에만 저장한다. 마크업의 원문은 한국어이고, 영어 모드에서는 `i18n.ts` 사전이 화면 문구·placeholder·aria-label을 렌더링 즉시 바꾼다. 사용자가 입력한 업무 제목·요청·모델 출력은 UI 문구와 정확히 같을 때만 바뀐다.

## 업무 내용의 AI 전송 동의

한 줄 업무 정의와 가져오기 분석은 `swarm`·`packs`·`coding`의 `model_data_approved` 중 하나, 또는 로컬 설정의 `work.model_data_approved`가 켜져 있어야 모델을 호출한다. 관제센터 AI 단계의 동의 체크박스는 `~/.agent-driver/runtime-config.json`에 `{"work":{"model_data_approved":true,"approved_at":"…"}}`를 기록한다. 값은 호출마다 파일에서 다시 읽고 config fingerprint에는 포함하지 않는다. 동의가 없으면 업무는 `needs_model`, 사유 `MODEL_DATA_APPROVAL_REQUIRED`로 저장되고 상세 화면에서 허용 후 재시도할 수 있다. 호스트가 직접 관리하는 설정 파일은 이 화면에서 바꾸지 않는다.

## 로컬 제어와 안전

업무 단계 수정은 같은 출처의 사용자 조작과 revision을 확인하고, 이미 실행한 후속 단계를 조용히 다시 쓰지 않는다. 화면·상태 API는 capability URL로 보호하며 작업 실행·외부 제출 권한을 만들지 않는다. 사이트 로그인 정보와 비밀번호는 snapshot·활동 로그에 기록하지 않는다.

Ubuntu Browser VM의 새 기본 메모리 할당은 3GiB이며 필요하면 `vm launch --memory-mib`로 조절할 수 있다. 이 시험은 VM 부팅과 Chromium 제어 연결까지만 확인했다. 장시간 다중 탭 작업의 안정성이나 VM 자동 절전·재개는 아직 검증·구현하지 않았다.
