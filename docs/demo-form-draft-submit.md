# `form.draft-submit` 공개 데모

이 데모는 Agent Driver가 소유한 Chromium으로 로컬 loopback 합성 포털을 실제로 열어 실행한다. 고객 포털, 실제 계정, 저장 비밀번호, 원격 Jev 제공자, Windows desktop executor를 사용하지 않는다.

보이는 순서는 다음과 같다.

1. 업무와 무관한 알려진 팝업을 Pack 정책으로 닫는다.
2. 검증된 값만 양식에 입력하고 시간 제약을 확인한다.
3. 제출 직전 화면을 캡처한다.
4. `waiting_approval`에서 멈춘다. 이 데모에서는 제출을 누르지 않아 외부 효과는 항상 0이다.

다음 명령으로 영상, 마지막 스냅샷, 영수증을 생성한다.

```bash
cd agent-driver
npm run demo:form
```

실행 결과는 시간별 `artifacts/demos/form-draft-submit/` 하위에 남는다.

- `agent-driver-form-draft-demo.webm`: 실제 owned-browser recording
- `agent-driver-form-draft-final.png`: 승인 직전 양식 증거
- `receipt.json`: `waiting_approval`, `effects: 0`, 합성 fixture임을 명시한 영수증

영상에는 반드시 “SYNTHETIC FIXTURE”와 “EXTERNAL EFFECTS: 0”을 유지한다. 따라서 영상은 자동화의 실제 실행 경계와 승인 대기를 보여 주지만, 실제 포털 제출 성공이나 모든 웹사이트 호환성을 입증하지 않는다.
