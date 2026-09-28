# Atlas에서 가져온 연결·인계 원칙

이번 변경은 Atlas를 실행 엔진으로 넣거나 코딩 IDE를 복제하는 작업이 아니다. 기존 Work, 승인, 체크포인트, 공식 CLI 실행 경로에서 연결 수명과 인계 증거를 더 정확하게 다룬다. 새 상주 프로세스나 화면 미러링은 추가하지 않는다.

## 적용한 것

| Atlas의 설계 | Agent Driver 적용 |
| --- | --- |
| 공통 AgentConnection과 선택적 기능 협상 | 버전 있는 판단 어댑터 기능 계약. 설치·인증 관측과 분리하고 실제 라우팅에서 지원 여부 확인 |
| 중복 connect 합류, 실패 후 정리, binary 변경 감지 | 같은 환경의 상태 확인 합류, 양성 캐시의 실행 파일/환경 지문, 실패 캐시 제거, 로그인 시작·취소 수명 관리 |
| 세션 수명과 프론트엔드 표시 분리 | 기존 SQLite Work와 단계가 업무 소유권을 유지. 로그인 UI의 취소·늦은 응답으로 중복 프로세스를 만들지 않음 |
| 실행 이벤트·체크포인트 근거의 명시적 계약 | 대상 모델·입력 해시·효과 상태를 교차 검증. 잘못된 응답/저장 실패를 공급자 장애로 위장하지 않음 |

기존에 이미 있는 기능은 유지했다. 프로젝트/Work/run/revision/실행 소유자에 묶인 압축 인계, 선택적 참조 본문, 실제 Git 변경 확인, 불확실한 쓰기의 자동 재실행 금지가 해당한다. Atlas의 임베딩/메모리 엔진, Rust 프로세스 매니저, 전체 ACP 프로토콜, rebase 뒤 patch-id 자동 대응은 이번에 추가하지 않았다.

## 사용자가 얻는 변화

연결 버튼을 겹쳐 눌러도 한 로그인 작업을 진행한다. 앱을 닫는 동안 상태 확인이 돌아왔다는 이유로 로그인 창이 뒤늦게 열리지 않는다. 클라이언트를 바꿔도 저장한 모델과 업무 식별자가 유지된다. 다른 모델이 답을 이미 반환했는데 인계 로그 저장이 실패했다고 해서 세 번째 모델을 또 호출하지 않는다. 검증되지 않은 쓰기는 계속 확인 대상으로 남는다.

상태 확인 합류는 모델 호출 횟수를 줄이는 기능이 아니다. 동시 상태 확인 10회를 1개 프로세스로 처리하되, 서로 다른 업무의 판단 4회는 4회 그대로 실행한다. 서로 다른 로그인 화면 소유자나 별도 MCP 서버 프로세스 사이의 전역 로그인 잠금은 보장하지 않는다. 절대 경로로 확인 가능한 실행 파일의 메타데이터와 환경 지문을 쓰며 인증 파일 본문은 읽지 않는다. 클라이언트 외부에서 바뀐 인증 상태는 다음 공식 상태 확인/실행 오류로 발견한다.

`transferred`는 대체 클라이언트의 응답 전달을 뜻한다. 업무 전체 성공, 답변의 사실성, 원래 대화 세션 자체의 이전을 의미하지 않는다. JSON 이후의 도메인 스키마와 권한·완료 조건은 Pack/Swarm가 검증한다. 코딩 검토에서는 인계 영수증을 만들기 전에 검토 스키마도 통과해야 한다.

## 근거와 소스

참조 저장소: [pacifio/atlas](https://github.com/pacifio/atlas), 확인한 커밋 `a34a6d44bf37d26d9a6f8f6fe1fab5ce0a92d8d1`.

- [ARCHITECTURE.md](https://github.com/pacifio/atlas/blob/a34a6d44bf37d26d9a6f8f6fe1fab5ce0a92d8d1/ARCHITECTURE.md): 연결 관리, 캐시 무효화, 모듈 간 계약.
- [AgentConnection](https://github.com/pacifio/atlas/blob/a34a6d44bf37d26d9a6f8f6fe1fab5ce0a92d8d1/crates/atlas-acp-thread/src/connection.rs): capability 기반 연결 인터페이스.
- [Wire contract tests](https://github.com/pacifio/atlas/blob/a34a6d44bf37d26d9a6f8f6fe1fab5ce0a92d8d1/crates/atlas-agent-wire/tests/contract.rs): 정규화된 이벤트/요청 계약.
- [Checkpoint](https://github.com/pacifio/atlas/blob/a34a6d44bf37d26d9a6f8f6fe1fab5ce0a92d8d1/crates/atlas-checkpoint/src/checkpoint.rs): 실행과 Git 증거의 연결.

TypeScript 구현은 기존 Agent Driver 구조에 맞춰 새로 작성했다. Atlas 소스 코드를 복사하거나 실행 의존성으로 추가하지 않았다. 구독→유료 API 금지, Jev 옵션, Pack이 소유하는 판단 지점은 그대로다.

## 검증 위치

Phase 73은 WSL 원본이 응답하지 않아 Windows 보존 사본에서 별도 후보로 구현했다. 원본의 미병합 Phase 72 변경은 덮어쓰지 않았다. [세션 인계 문서](handoff/phase-73.md)에 검사 결과와 원본 병합 전 조건을 기록한다. Windows 검사 통과와 WSL 원본 반영/운영 검증은 서로 다른 상태다.
