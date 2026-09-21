# 실제 웹 가격 모니터 데모

`travel.price-watch`는 공개 검색 결과를 한 번 수집해 가격 조건에 맞는 **알림 후보**를 만든다. `research.search`와 `monitor.watch`를 결합한 구체 Pack이며, 검색·수집과 예약 권한을 분리한다. 현재 읽기 전용 source adapter는 다음 두 개다.

- Google Flights: 항공권 경로·날짜의 공개 검색 결과
- Booking.com: 도시·체크인/체크아웃·인원 조건의 공개 숙소 검색 결과

이 Pack은 검색·비교·로컬 증거 캡처까지만 한다. 로그인, 예약, 결제, 개인정보 동의 수락, CAPTCHA 해제, 외부 메시지 발송은 하지 않는다. CAPTCHA·보안 경고·쿠키/개인정보 동의가 필요하면 값이 없다고 만들지 않고 `blocked`로 기록한다. 결과 카드가 시간 안에 보이지 않으면 `unobserved`다.

실제 공개 페이지를 한 번 확인하고 WebM/스크린샷/영수증을 남기려면 다음을 실행한다.

```bash
cd agent-driver
npm run demo:travel -- google_flights
npm run demo:travel -- booking
```

각 실행은 `artifacts/demos/travel-price-watch/<time>/` 아래에 독립적으로 남는다. `receipt.json`의 `external_notifications`는 항상 `0`이다. 따라서 마케팅 영상에서는 “실제 사이트의 읽기 전용 검색과 낮은 가격 조건 판단”까지만 말할 수 있으며, 실시간 푸시 알림·예약·결제·모든 지역/언어의 사이트 호환성을 주장하면 안 된다.

현재 이 환경에서는 Google Flights의 실제 공개 결과 관측·캡처·WebM을 확인했다. Booking.com은 같은 agent-owned browser에서 검색 URL을 열었지만 결과 카드를 관측하지 못해 `unobserved`로 끝났다. 이 상태는 가격 `0`이나 성공으로 바꾸지 않으며, 그 source의 영상에도 쓰지 않는다. Booking 결과가 실제로 관측되는 환경에서만 숙소 대상의 가격 조건 판정을 활성화한다.

이 데모의 직접 공개 URL 관측은 source adapter가 결과를 읽을 수 있는지 확인한 **low-volume probe**다. 현재 실제 경로는 Playwright 기반 source adapter이며 Jev/LLM의 hand 선택 helper를 호출하지 않는다. selector·직접 URL·DOM 조작 자체는 금지 대상이 아니며, 검증된 검색·입력 절차에도 사용할 수 있다. 후속 적응형 경로에서는 Pack 설계에 따라 Jev가 행동·대상을 선택하거나 LLM이 탐색·재계획하고 같은 브라우저 도구로 실행한다. 이 probe의 속도만으로 모든 상황에 같은 손이 우월하다고 결론 내리지 않는다.

반복 실행과 실제 알림 전송은 후속 control-plane 작업이다. 전송을 붙일 때도 가격 관측 Pack과 알림 채널 권한을 분리하고, 조건·대상·빈도·중복 억제 키를 각각 저장해야 한다.
