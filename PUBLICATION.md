# 공개 범위

이 저장소는 로컬 연구 작업 공간에서 명시적 파일 allowlist로 내보낸 제품 소스다. 원본 연구 파일을 삭제하거나 실패를 수정하지 않았다.

- 포함: TypeScript source, owned synthetic test app, 새 runtime tests, 설계와 집계 평가, CI, 고정 버전 manifest.
- 제외: 원시 API 응답/response ID, 인증/로그인 정보, 원본 사용자 입력/계정 자료, browser profile, SQLite DB, 실행 로그, 환경별 handoff, 대규모 private 평가 산출물.
- 공개 package manifest는 연구 전용 명령과 사용하지 않는 연구 의존성을 제거한 projection이다. 런타임 Node/Playwright/PTY/TypeScript 버전은 로컬 고정 버전과 같다. 원본 환경의 lockfile/평가 증거는 별도로 보존한다.
- 생성되는 `tests/report.json`, `tests/evidence/`, `.runtime/`는 기본 gitignore 대상이다. CI artifact는 합성 runtime 테스트 기록만 포함한다.
- 공개 전 scanner는 credential/private-key/계정 경로 패턴을 검사한다. 패턴 검사가 개인정보 검토를 완전히 대체하지는 않는다.

공개 라이선스는 아직 결정하지 않았다. API 요청 키를 issue/PR/로그에 붙여 넣지 않는다. 운영 배포·자동 merge·실계정 데이터 업로드는 이 공개 작업에 포함하지 않았다.
