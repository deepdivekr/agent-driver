/** Display-only copy. Never apply these rules to stored requests, output, commands or receipts.
 * Buttons name the next action; states distinguish saved, running and verified results.
 * Korean descriptions use conversational endings. Costs, permissions and limits remain explicit. */
export const reviewedCopy: Record<string, readonly [string, string]> = {
  '후속 단계가 새 결과를 받습니다. 각 후속 단계의 기존 목표 문구는 자동으로 바뀌지 않으므로 확인하세요.': ['다음 단계에 새 결과를 전달해요. 각 단계의 기존 목표는 자동으로 바뀌지 않아요. 확인해 주세요.', 'Later stages receive the new result. Their goals do not change automatically; review them.'],
  'mcp client': ['AI 앱', 'AI app'],
  'stdio · observe · pack plan': ['업무 접수 · 기록 · 전달', 'Receive · record · deliver'],
  'LOCAL': ['이 컴퓨터', 'This computer'],
  'no cloud relay': ['로컬에서 실행', 'Runs locally'],
  '여기서 반복 실행을 켜면 기존 플랫폼의 예약은 직접 꺼 주세요. 둘 다 켜 두면 양쪽에서 실행됩니다.': ['기본은 이번 회차만 실행해요. 반복 실행을 켜려면 기존 플랫폼의 예약은 직접 꺼 주세요. 둘 다 켜 두면 양쪽에서 실행돼요.', 'Only this cycle runs by default. If you enable recurring runs here, turn off the original platform schedule. Leaving both on runs the work in both places.'],
  'exact ID (account unverified)': ['모델 ID · 계정 권한 미확인', 'exact ID (account access unverified)'],
  'client alias (version may vary)': ['앱 기본 모델 · 버전은 달라질 수 있어요', 'app default (version may vary)'],
  '현재 확인: ': ['확인한 모델: ', 'Models checked: '],
  '저장한 Codex 모델을 이 계정에서 쓸 수 없습니다. 목록에서 다시 선택하세요.': ['저장한 Codex 모델이 현재 목록에 없어요. 목록에서 다시 선택해 주세요.', 'The saved Codex model is not in this account’s model list. Choose another model from the list.'],
  '새 기본 Codex 모델은 현재 계정 목록에 없습니다. 지원 모델을 선택하세요.': ['새 기본 Codex 모델이 현재 목록에 없어요. 목록에 있는 모델을 선택해 주세요.', 'The new default Codex model is not in this account’s model list. Choose a model from the list.'],
  '요청한 Codex 6.1 Sol을 현재 계정 목록에서 확인했습니다.': ['현재 목록에서 Codex 6.1 Sol을 확인했어요.', 'Codex 6.1 Sol is in this account’s model list.'],
  'Claude 목록은 계정 지원 확인이 아닙니다.': ['Claude 모델 목록은 계정 사용 권한을 보장하지 않아요.', 'The Claude model list does not confirm account access.'],
  '기본은 백그라운드 브라우저(Playwright)입니다. Aside를 연결해 두면 사이트가 접근을 막을 때 자동으로 넘겨 읽습니다.': ['기본은 백그라운드 브라우저인 Playwright예요. 사이트가 접근을 막으면 연결된 Aside로 넘겨 읽어요.', 'Playwright runs in the background by default. If a site blocks access, the connected Aside browser takes over.'],
  '기본은 Playwright입니다. Aside·Neo는 원할 때만 연결하세요. 사이트 로그인은 업무에 필요할 때 안내합니다.': ['Playwright를 기본으로 사용해요. Aside·Neo는 필요할 때 연결해 주세요. 사이트 로그인도 업무에 필요할 때 안내해요.', 'Playwright is the default. Connect Aside or Neo when needed. You’ll be asked to sign in to a site when work requires it.'],
  '사용할 컴퓨터에 Neo를 설치·실행하고 로컬 MCP 연결을 켜세요. 기본 주소는 127.0.0.1:9010/mcp입니다.': ['사용할 컴퓨터에 Neo를 설치한 뒤 실행하고, 로컬 MCP 연결을 켜 주세요. 기본 주소는 127.0.0.1:9010/mcp예요.', 'Install and run Neo on the computer you’ll use, then enable its local MCP connection. The default address is 127.0.0.1:9010/mcp.'],
  '완료 조건': ['완료 기준', 'Completion criteria'],
  '업무 지침': ['업무 지침', 'Instructions'],
  '작업 지침': ['업무 지침', 'Instructions'],
  '작업물 확인 방법': ['결과 받을 곳', 'Receive results'],
  '결과 전달': ['결과 보내기', 'Result delivery'],
  '결과 전달 대상': ['결과 받을 곳', 'Result destinations'],
  '전달 대상 추가': ['받을 곳 추가', 'Add destination'],
  '새 업무의 기본 전달 대상': ['새 업무의 기본 수신처', 'Default result destinations'],
  '업무 결과를 확인할 곳을 연결하세요. 앱은 항상 사용할 수 있습니다.': ['결과를 받을 메신저를 연결해 주세요. 이 앱에서도 결과를 볼 수 있어요.', 'Connect a messenger to receive results. Results are also available in this app.'],
  '연결 정보는 저장 후 실제 전송 때 확인됩니다.': ['설정을 저장해도 연결이 확인된 것은 아니에요. 첫 전송 때 확인해요.', 'Saving settings does not verify the connection. It is checked on the first send.'],
  '업무 현황에서 업무별 전달 대상을 바꿀 수 있습니다.': ['업무 상세에서 결과 받을 곳을 바꿀 수 있어요.', 'Change result destinations in the work detail.'],
  '업무 보기': ['업무 보기', 'Open work'],
  '에서 업무별 전달 대상을 바꿀 수 있습니다.': ['에서 결과 받을 곳을 바꿀 수 있어요.', ' to change result destinations.'],
  '메신저로 결과 본문을 보냅니다. 긴 본문은 Telegram·Discord에서 파일로 첨부되고, Slack에서는 전송되지 않습니다.': ['결과 본문을 메신저로 보내요. 긴 본문은 Telegram·Discord에 파일로 보내고, Slack에는 보내지 않아요.', 'Results are sent as text. Long results are attached as files on Telegram and Discord; they are not sent on Slack.'],
  '역할별 모델': ['역할별 AI 모델', 'Models by role'],
  '기본 클라이언트': ['먼저 사용할 AI 앱', 'Preferred AI app'],
  '우선 사용할 클라이언트': ['먼저 사용할 AI 앱', 'Preferred AI app'],
  '앱별 기본 모델': ['앱별 기본 모델', 'Default models by app'],
  '클라이언트 기본값': ['앱 기본값', 'App default'],
  '구독 모델 후보를 확인할 수 없어 기본 모델을 유지합니다.': ['구독 모델 목록을 확인하지 못해 기본 모델을 사용해요.', 'The subscription model list is unavailable. Using the default models.'],
  '자동 배분이 불가하여 저장된 기본 모델로 진행합니다.': ['모델을 자동으로 나누지 못해 기본 모델로 진행해요.', 'Automatic assignment was unavailable. Using the default models.'],
  '사용하지 않는 역할은 별도 에이전트를 만들지 않습니다.': ['필요한 역할에만 에이전트를 만들어요.', 'Agents are created only for the roles needed.'],
  '모델 목록은 연결된 앱에서 가져옵니다. 기본 모델을 이 계정에서 쓸 수 있는지는 아직 확인하지 못했습니다.': ['연결된 앱에서 가져온 모델 목록이에요. 이 계정의 기본 모델 사용 권한은 아직 확인되지 않았어요.', 'Models come from the connected app. Access to the default model has not been verified for this account.'],
  'CLI 자동 업데이트': ['AI 앱 자동 업데이트', 'Automatic AI app updates'],
  '24시간마다 확인하고, 업무 실행 중에는 업데이트를 미룹니다. 처음에는 AI 설정 저장 후 적용됩니다.': ['AI 설정을 저장하면 하루마다 업데이트를 확인해요. 업무가 실행 중이면 나중에 업데이트해요.', 'After you save AI settings, updates are checked daily and deferred while work is running.'],
  '업무 요청 저장': ['업무 요청 저장됨', 'Request saved'],
  '업무 계획 저장': ['업무 계획 저장됨', 'Plan saved'],
  '일시정지 기록': ['일시정지 요청 기록됨', 'Pause request recorded'],
  '재개 기록': ['재개 요청 기록됨', 'Resume request recorded'],
  '완료조건 검증 통과': ['완료 기준 충족', 'Completion criteria met'],
  '완료조건 검증 미통과': ['완료 기준 미충족', 'Completion criteria not met'],
  '완료조건 검증 확인 불가': ['완료 여부 확인 불가', 'Completion could not be verified'],
  '완료조건 검증 기록': ['완료 확인 기록', 'Completion check history'],
  '실행기': ['실행 도구', 'Execution tool'],
  '계획의 Pack': ['사용할 Pack', 'Planned Pack'],
  '관측된 실행기': ['사용한 실행 도구', 'Execution tool used'],
  '최근 관측된 실행기': ['최근 사용한 실행 도구', 'Latest execution tool'],
  '최근 관측한 출처': ['최근 읽은 출처', 'Recently read sources'],
  '예정 실행 경로': ['사용할 실행 환경', 'Planned execution environment'],
  '실행 경로': ['실행 환경', 'Execution environment'],
  '진행 단계': ['업무 진행', 'Progress'],
  '단계 진척도': ['단계 진행률', 'Stage progress'],
  '작업 제어': ['업무 관리', 'Work controls'],
  '업무 실행 제어': ['업무 관리', 'Work controls'],
  '아직 배정되지 않음': ['아직 담당이 없어요', 'Not assigned yet'],
  '미관측': ['확인되지 않음', 'Not confirmed'],
  '관측 없음': ['확인 기록 없음', 'No observations yet'],
  '시간 미관측': ['소요 시간 미확인', 'Duration not reported'],
  '마지막 로그인 상태 관측': ['마지막 로그인 확인', 'Last login check'],
  '현재 활성 서브에이전트': ['실행 중인 하위 에이전트', 'Active sub-agents'],
  '현재 활성 작업자': ['실행 중인 에이전트', 'Active agents'],
  '도구 기록 확인': ['확인된 도구 기록', 'Confirmed tool events'],
  '브라우저 화면 관측 확인': ['브라우저 화면 확인됨', 'Browser page observed'],
  '출처 조회 확인': ['출처 읽기 확인됨', 'Source read confirmed'],
  '읽은 링크 목록 확인': ['읽은 링크 확인 중', 'Checking observed links'],
  '실행 요약': ['진행 기록', 'Activity'],
  '실제로 일어난 일만 기록합니다.': ['실제 실행 기록이에요. 새 기록이 없어도 완료된 것은 아니에요.', 'These are actual execution events. A quiet log does not mean completion.'],
  '실제로 수행한 도구 단계 기준 · 완료조건 확인은 결과에 별도 표시': ['실행한 단계의 진행률이에요. 완료 기준 충족 여부는 결과에서 확인해요.', 'Progress shows executed stages. Completion criteria are checked separately with the result.'],
  'Run 성공은 Work의 모든 완료조건 충족을 자동으로 뜻하지 않습니다.': ['실행이 끝나도 모든 완료 기준을 충족한 것은 아닐 수 있어요. 결과의 확인 상태를 함께 봐 주세요.', 'A finished run may not meet every completion criterion. Check the verification status with the result.'],
  '단계별 확인 미지원': ['단계별 확인은 제공하지 않아요', 'Per-stage verification is unavailable'],
  '이 실행 경로는 단계별 독립 검증 결과를 보고하지 않음': ['이 실행 환경은 단계별 확인 결과를 제공하지 않아요', 'This execution environment does not report per-stage verification'],
  '실행을 접수했습니다. 첫 단계의 실제 기록을 기다립니다.': ['실행을 요청했어요. 첫 단계가 시작되면 여기에 표시해요.', 'Execution requested. The first stage will appear here when it starts.'],
  '실행을 접수했습니다. 현재 작업과 실제 로그를 확인하세요.': ['실행을 요청했어요. 아래에서 진행 상황을 확인해 주세요.', 'Execution requested. Follow progress below.'],
  '저장된 실행 상태를 확인하세요. 현재 실행은 아직 관측되지 않았습니다.': ['저장된 기록은 있지만, 지금 실행 중인지는 확인되지 않았어요.', 'Saved records are available, but a current run has not been confirmed.'],
  '계획과 관측은 구분합니다. 실제 실행 기록은 아래 로그에 표시합니다.': ['예정된 계획과 실제 진행은 다를 수 있어요. 아래 기록에서 확인해 주세요.', 'The plan may differ from actual progress. Follow the activity below.'],
  '업무를 실행 대기열에 넣었습니다. 실행 연결과 저장된 진행 지점을 확인합니다.': ['실행 대기 중이에요. 연결 상태와 저장된 진행 지점을 확인해요.', 'The work is queued. Checking connections and saved progress.'],
  '업무 분석 중입니다. 분석 결과와 다음 기록을 기다립니다.': ['AI가 업무를 분석하고 있어요. 결과가 나오면 여기에 표시해요.', 'AI is analyzing the work. The result will appear here.'],
  'AI가 업무 지침과 완료조건을 분석 중입니다.': ['AI가 업무 지침과 완료 기준을 정리하고 있어요.', 'AI is organizing your instructions and completion criteria.'],
  '업무 정의 중': ['업무 분석 중', 'Analyzing work'],
  '업무 정의 재시도': ['업무 다시 분석', 'Analyze again'],
  '지침·완료조건·실행 계획 구성': ['업무 지침·완료 기준·실행 계획 정리', 'Organizing instructions, completion criteria and the plan'],
  '에이전트 실행 배정 대기': ['연결된 에이전트의 실행 대기', 'Waiting for the connected agent'],
  '업무 정의는 저장됐습니다. 연결된 에이전트가 Pack과 실행기를 호출하면 작업이 시작됩니다.': ['업무를 저장했어요. 연결된 에이전트가 실행 도구를 호출하면 시작해요.', 'Work saved. It starts when the connected agent calls the execution tools.'],
  '아직 맡긴 업무가 없습니다. 위에서 한 줄로 업무를 시작하세요.': ['어떤 업무를 맡길까요? 위에 한 줄로 적어 주세요.', 'What would you like done? Describe it above in one line.'],
  '한 줄로 어떤 업무를 맡길까요?': ['어떤 업무를 맡길까요?', 'What would you like done?'],
  '되묻기 · 결과에 중요한 조건을 먼저 질문': ['시작 전 필요한 조건 물어보기', 'Ask about important details before starting'],
  '업무 접수': ['업무 시작', 'Start work'],
  '업무를 시작하면 선택한 AI의 사용량이 듭니다.': ['업무를 시작하면 선택한 AI의 사용량이 차감돼요.', 'Starting work uses your selected AI allowance.'],
  'AI는 앱에서 직접 쓸 때와 같은 권한으로 실행합니다.': ['AI는 앱에서 직접 쓸 때와 같은 권한으로 실행해요.', 'The AI runs with the same permissions as when you use the app yourself.'],
  '요청을 저장했습니다. 실제 분석과 실행 기록을 확인하는 중…': ['요청을 저장했어요. 분석과 실행이 시작되는지 확인하고 있어요.', 'Request saved. Checking for analysis and execution events…'],
  '업무 내용을 AI에 보내도록 허용해 주세요. 허용하면 AI가 업무를 분석합니다.': ['업무를 분석하려면 내용을 AI에 보내야 해요. 전송을 허용해 주세요.', 'AI needs your work instructions to analyze them. Allow sending this content to your AI.'],
  '선택 후 시작': ['선택하고 시작', 'Choose and start'],
  '목표': ['업무 목표', 'Goal'],
  '설명 보기': ['자세히 보기', 'Learn more'],
  '설명': ['도움말', 'Help'],
  '분석 범위 안내': ['분석 범위 보기', 'About the scan'],
  '가져오기 방식': ['가져오는 방법', 'Import method'],
  '다른 AI의 자동화': ['다른 AI에서 가져오기', 'Import from another AI'],
  '워크플로 프로젝트': ['프로젝트에서 가져오기', 'Import from a project'],
  '프로젝트 살펴보기': ['프로젝트 분석', 'Analyze project'],
  '봇 프로젝트 살펴보기': ['봇 분석', 'Analyze bot'],
  '프로젝트 이전 초안': ['가져올 업무 초안', 'Imported work draft'],
  '자동화 이전 초안': ['가져올 자동화 초안', 'Imported automation draft'],
  '새 Work의 목표': ['가져올 업무의 목표', 'Imported work goal'],
  'Work 초안 저장': ['업무 초안 저장', 'Save work draft'],
  '개선 Work 만들기': ['개선 업무 만들기', 'Create improvement work'],
  'Office에서 새 업무로 실행': ['새 업무로 시작', 'Start as new work'],
  '이 Work에서 Jev 사용': ['이 업무에서 Jev 사용', 'Use Jev for this work'],
  '어떤 업무를 가져올까요? · 선택': ['가져올 업무 · 선택', 'Work to import · optional'],
  '한 회차가 끝났음을 어떻게 확인할까요?': ['어떤 결과가 나오면 완료일까요?', 'What result means this run is complete?'],
  '원본 별도 확인 필요': ['원본 확인 필요', 'Check the original'],
  '원본 실행 연결이 필요합니다. 코드 분석만으로 봇의 실행 상태를 보거나 중단·지시를 전달할 수는 없습니다.': ['실행 상태를 보거나 지시를 보내려면 원래 봇이 도는 환경에 연결해야 해요. 코드 분석만으로는 제어할 수 없어요.', 'Connect to the bot’s original runtime to monitor it or send instructions. Reading its code does not enable control.'],
  '기존 봇 유지 · 관제 연결 준비': ['기존 봇 그대로 연결', 'Connect the existing bot'],
  '관제 연결 준비': ['봇 연결 준비', 'Prepare bot connection'],
  '읽기 전용 분석에서 나온 제안입니다. 실제 반복 빈도·정답률·속도 이득은 아직 검증되지 않았습니다. Work에서 Jev를 켜도 이 후보 단계에 자동으로 삽입되지는 않습니다.': ['코드 분석으로 찾은 제안이에요. 정확도와 속도 개선은 아직 확인하지 않았어요. Jev를 켜도 이 단계에 자동으로 추가되지는 않아요.', 'This suggestion comes from code analysis. Accuracy and speed gains have not been verified. Turning on Jev does not automatically add it to this step.'],
  'Jev 추천 없음 · 연결 지점은 아직 분석되지 않았습니다.': ['Jev 사용 제안 없음 · 아직 분석하지 않았어요.', 'No Jev suggestion · not analyzed yet.'],
  '연결 지점은 아직 분석되지 않았습니다.': ['Jev를 쓸 단계는 아직 분석하지 않았어요.', 'Where to use Jev has not been analyzed yet.'],
  'Jev가 도움이 될 수 있는 지점': ['Jev가 도움이 될 단계', 'Where Jev could help'],
  'API 비용 가능성을 확인했습니다': ['API 비용이 발생할 수 있음을 확인했어요', 'I understand API costs may apply'],
  'Jev API 비용 가능성을 확인하고 연결에 동의합니다': ['Jev API 비용을 확인했고 연결에 동의해요', 'I understand Jev API costs and agree to connect'],
  '이 Work에서 Jev를 켰습니다. API 비용이 발생할 수 있습니다.': ['이 업무에서 Jev를 켰어요. API 비용이 발생할 수 있어요.', 'Jev is on for this work. API costs may apply.'],
  '이 Work에서 Jev를 껐습니다.': ['이 업무에서 Jev를 껐어요.', 'Jev is off for this work.'],
  'AI의 프로젝트 자료 사용이 승인되지 않아 연결 지점을 분석하지 않았습니다.': ['프로젝트 자료를 AI에 보내도록 허용하지 않아 Jev 사용 단계를 분석하지 않았어요.', 'Jev suggestions were not analyzed because AI access to project data is not approved.'],
  '에이전트 연결': ['AI 앱 연결', 'Connect AI apps'],
  'Agent Office 런타임': ['Agent Office', 'Agent Office'],
  '설치됨 · MCP 서버 준비됨': ['설치됨 · 연결 준비 완료', 'Installed · ready to connect'],
  'MCP 등록 필요': ['연결 필요', 'Connection needed'],
  'MCP 등록됨': ['연결 등록됨', 'Connection registered'],
  'MCP 연결': ['연결', 'Connect'],
  'MCP 등록 미확인': ['연결 등록 미확인', 'Registration not verified'],
  '로그인 확인됨 · MCP를 연결하면 준비가 끝납니다.': ['로그인했어요. 연결하면 준비가 끝나요.', 'You are signed in. Connect to finish setup.'],
  '공식 로그인은 이 앱이 관리하며 Agent Driver는 토큰을 읽지 않습니다.': ['로그인과 갱신은 연결한 앱이 관리해요. Agent Office는 인증 토큰을 읽지 않아요.', 'The connected app manages sign-in and renewal. Agent Office does not read its authentication tokens.'],
  '업무를 맡길 앱을 연결하세요. 앱이 없으면 여기에서 설치와 로그인, MCP 등록을 진행할 수 있습니다.': ['업무에 사용할 AI 앱을 연결해 주세요. 설치와 로그인도 여기서 시작할 수 있어요.', 'Connect an AI app for your work. You can start installation and sign-in here.'],
  'AI 연결': ['AI 설정', 'AI settings'],
  '로컬 실행': ['실행 환경', 'Execution environment'],
  '전용 작업 환경': ['전용 실행 환경', 'Dedicated execution environment'],
  '로컬 실행 승인': ['실행 환경 연결', 'Connect execution environment'],
  '전역 · 기본 AI': ['모든 업무의 기본 AI', 'Default AI for all work'],
  '코딩 업무 전용': ['코딩 업무용 AI', 'AI for coding work'],
  '설정 대상': ['적용할 업무', 'Apply to'],
  '연결 방식': ['AI 사용 방식', 'AI connection'],
  '업무 내용을 선택한 AI로 보내 정의·계획하도록 허용': ['업무 내용을 AI에 보내 분석과 실행 허용', 'Allow AI to analyze and run your work'],
  '빠른 반복 판단에 사용합니다. 연결하지 않아도 LLM으로 진행합니다.': ['짧고 반복적인 판단에 사용해요. 연결하지 않아도 AI로 진행할 수 있어요.', 'Used for short, repeated decisions. Your AI can continue without Jev.'],
  '구독 한도를 소진해도 유료 API로 자동 전환하지 않습니다.': ['구독 한도를 다 써도 유료 API로 자동 전환하지 않아요.', 'A subscription limit never triggers an automatic switch to a paid API.'],
  'Windows AI 앱 연결 · 선택': ['Windows AI 앱 연결 · 선택', 'Connect a Windows AI app · optional'],
  '앱 연결 확인을 마쳤습니다. 클라이언트별 결과를 확인하세요.': ['연결 확인을 마쳤어요. 각 앱의 상태를 확인해 주세요.', 'Connection check finished. See each app’s status.'],
  'WSL 앱이 없다면 Windows 앱에 연결 정보를 등록하고 계속하세요. 등록 여부는 아직 확인되지 않았습니다.': ['Windows AI 앱만 쓴다면 아래 연결 설정을 등록해 주세요. 이 화면에서는 등록 여부를 확인할 수 없어요.', 'If you only use a Windows AI app, add the connection settings below. This page cannot verify its registration.'],
  '브라우저마다 로그인 상태가 별도로 유지됩니다.': ['로그인은 브라우저별로 따로 유지돼요.', 'Each browser keeps its own sign-in state.'],
  '로그인 유지가 켜져 있습니다. 아직 저장된 로그인이나 인증 성공을 뜻하지 않습니다.': ['로그인을 유지하도록 설정했어요. 실제 로그인 성공 여부는 따로 확인해야 해요.', 'Login retention is enabled. Successful sign-in must be verified separately.'],
  '프로필 설정 저장': ['로그인 유지 설정 저장', 'Save login retention'],
  '프로필 설정을 저장했습니다. 설정 다시 적용을 누르세요.': ['로그인 유지 설정을 저장했어요. 설정 다시 적용을 눌러 반영해 주세요.', 'Login retention saved. Select Reapply settings to apply it.'],
  '직접 다시 확인은 제한된 같은 환경의 창만 엽니다. 제한을 지우거나 업무를 자동 재개하지 않습니다.': ['같은 환경에서 로그인 창을 다시 열어요. 사이트 제한을 해제하거나 업무를 자동 재개하지는 않아요.', 'Reopens sign-in in the same environment. It does not remove site restrictions or automatically resume work.'],
  '브라우저를 확인했습니다. 화면·프로필 사용을 허용하면 Office에 연결됩니다.': ['브라우저를 확인했어요. 화면과 로그인 프로필 사용을 허용하면 연결할 수 있어요.', 'Browser found. Allow access to its screen and login profile to connect.'],
  '연결하지 못했습니다. 설명 보기를 확인하세요.': ['연결하지 못했어요. 자세히 보기에서 연결 방법을 확인해 주세요.', 'Could not connect. Open Learn more for setup help.'],
  '관측 결과를 바탕으로 다음 작업 결정': ['확인한 결과로 다음 작업 선택', 'Choose the next action from confirmed results'],
  '정리안을 따로 승인한 후 이동 허용': ['정리안을 확인한 뒤 파일 이동 허용', 'Allow file moves after approving the plan'],
  '이 정리안 승인하고 이동': ['승인하고 파일 이동', 'Approve and move files'],
  '이 폴더 접근 허용': ['폴더 접근 허용', 'Allow folder access'],
  '코드 작업은 Codex·Claude CLI가 합니다. API는 계획과 조언에만 쓰이고, 공급자와 주소가 같으면 전역 API 키를 함께 씁니다.': ['코드는 Codex·Claude CLI가 수정해요. API는 계획과 조언에만 써요. 공급자와 주소가 같으면 기본 API 키를 함께 사용해요.', 'Codex or Claude CLI edits code. The API is used only for planning and advice. The default API key is shared when the provider and address match.'],
  '상위 에이전트 조언': ['다음 작업 제안', 'Suggested next steps'],
  '코딩은 Codex가 합니다. 다른 AI의 조언은 따로 표시합니다. 새 지시를 보내야 다음 작업을 시작합니다.': ['코딩은 Codex가 맡아요. 다른 AI의 제안은 따로 보여 드려요. 새 지시를 보내면 다음 작업을 시작해요.', 'Codex does the coding. Suggestions from another AI are shown separately. Send a new instruction to start the next task.'],
  '프로젝트와 세션을 연결해 Work 시작': ['세션 연결', 'Connect session'],
  '고정 계획 방식': ['단계별 실행', 'Run stage by stage'],
  '기존 Codex 대화 이어받기': ['Codex 대화 이어가기', 'Continue a Codex conversation'],
  '업무 처리': ['업무 처리', 'Work processing'],
  '업무': ['업무', 'Work'],
  '도구': ['도구', 'Tools'],
  '코드': ['코드', 'Code'],
  '사용자': ['사용자', 'You'],
  '이 컴퓨터에서 실행': ['이 컴퓨터에서 실행', 'Runs on this computer'],
  '로컬 연결 · MCP': ['로컬 연결 · MCP', 'Local connection · MCP'],
  '연결 오류': ['연결하지 못했어요', 'Could not connect'],
  '연결 상태 확인 중…': ['연결 상태 확인 중…', 'Checking connections…'],
  '아직 연결 작업 기록이 없습니다.': ['아직 연결 기록이 없어요.', 'No connection events yet.'],
  '현재 계정 목록에 없음': ['현재 계정 목록에 없음', 'Not in this account’s model list'],
  '이 계정에서 쓸 수 없는 Codex 모델입니다. 목록에서 다시 선택하세요.': ['현재 모델 목록에 없는 Codex 모델이에요. 목록에서 다시 선택해 주세요.', 'This Codex model is not in your account’s model list. Choose another model from the list.'],
  '키 저장됨': ['키 저장됨', 'Key saved'],
  '키 필요': ['키 필요', 'Key needed'],
  '연결 전': ['연결 전', 'Not connected'],
  '키를 입력하세요': ['키를 입력해 주세요', 'Enter a key'],
  '저장됨 · 발송 연결 미확인': ['설정 저장됨 · 전송 확인 전', 'Settings saved · delivery not verified'],
  '일부 목록만 표시합니다. 최신 대화 50개·예약 100개까지 읽었습니다.': ['목록 일부만 보여요. 최신 대화 50개와 예약 100개까지 읽었어요.', 'Showing part of the list. Read up to the latest 50 chats and 100 schedules.'],
  '서버 연결을 확인하지 못했습니다. 아래는 마지막 관측 기록입니다.': ['서버 연결을 확인하지 못했어요. 아래는 마지막으로 확인한 기록이에요.', 'Could not check the server connection. The records below are the last ones seen.'],
  '· 비밀값 가림': ['· 비밀값 가림', '· secrets hidden'],
  '완료 조건 ·': ['완료 기준 ·', 'Completion criterion ·'],
  '관측된 실행기: ': ['확인된 실행 도구: ', 'Execution tool seen: '],
  '키 입력 후 새로고침하면 최신 목록을 불러옵니다': ['키를 입력하고 새로고침하면 최신 목록을 불러와요', 'Enter a key and refresh for the latest list'],
  '대상 이름': ['받을 곳 이름', 'Destination name'],
  '원본에서 전달 · 여부 미확인': ['원래 환경에서 전달 관리 · 수신 미확인', 'Delivery managed by the original runtime · receipt not verified'],
  '원본 보고 · 독립 확인 전': ['원래 봇의 보고 · 별도 확인 전', 'Reported by the original bot · not independently verified'],
  '실행기가 보고한 결과': ['실행 도구가 보고한 결과', 'Result reported by the execution tool'],
  '업무 완료조건 확인됨': ['업무 완료 기준 충족', 'Work completion criteria met'],
  '현재 실행 미관측': ['현재 실행 여부 미확인', 'Current execution not confirmed'],
  '결과 관측 · 단계 확인 대기': ['결과 있음 · 단계 확인 대기', 'Result available · stage verification pending'],
  '실행기 미관측': ['사용한 도구 미확인', 'Execution tool not confirmed'],
  '업무 단계 실행': ['단계 진행률', 'Stage progress'],
  '단계별 진행률 미관측': ['단계별 진행률 미확인', 'Stage progress not reported'],
  '상위 에이전트 조언은 제공되지 않았습니다. Codex 답변은 보존했습니다.': ['다음 작업 제안을 받지 못했어요. Codex 답변은 그대로 남아 있어요.', 'No next-step suggestion was received. The Codex reply is kept.'],
  '이 WSL/Linux 환경에 클라이언트가 설치되지 않았습니다.': ['이 WSL/Linux 환경에 AI 앱이 설치되지 않았어요.', 'The AI app is not installed in this WSL/Linux environment.'],
  '선택한 모델을 현재 연결된 클라이언트에서 사용할 수 없습니다. 연결 및 설정에서 모델 목록을 새로고침하세요.': ['연결된 AI 앱에서 선택한 모델을 사용할 수 없어요. 연결 및 설정에서 모델 목록을 새로고침해 주세요.', 'The selected model is unavailable in the connected AI app. Refresh models in Connections & settings.'],
  'Agent Office가 AI에 보낸 요청 형식에 오류가 있습니다. 로그인이나 사용량 문제가 아니라 앱 오류이니, 앱을 업데이트한 뒤 다시 시도해 주세요.': ['AI에 보낸 요청 형식에 앱 오류가 있어요. 로그인이나 사용량 문제는 아니에요. Agent Office를 업데이트한 뒤 다시 시도해 주세요.', 'The app sent an invalid AI request. This is not a sign-in or quota issue. Update Agent Office and retry.'],
  'CURRENT LOOP': ['현재 진행', 'Current progress'],
  'REVIEW FIRST': ['먼저 확인해 주세요', 'Review first'],
  'IMPORT WORK': ['가져오기', 'Import'],
  'AI 앱': ['AI 앱', 'AI apps'],
  '업무를 맡는 앱은 Codex와 Claude Code예요. 다른 앱은 Office에 업무를 건네는 연결만 해요.': ['업무를 맡는 앱은 Codex와 Claude Code예요. 다른 앱은 Office에 업무를 건네는 연결만 해요.', 'Codex and Claude Code take on Work. The other apps only hand Work to Office.'],
  'AI 설정': ['AI 설정', 'AI settings'],
  'run not started': ['아직 실행 전', 'Not started'],
  'work': ['업무', 'Work'],
  'pack': ['Pack', 'Pack'],
  'read-only': ['읽기 전용', 'Read only'],
  'draft only': ['초안만 작성', 'Draft only'],
  'change after approval': ['승인 후 변경', 'Changes need approval'],
  'Applying the saved runtime settings. No Work is being replayed.': ['저장된 실행 설정을 적용하고 있어요. 업무는 다시 실행하지 않아요.', 'Applying the saved execution settings. No work is being replayed.'],
  'Saved runtime settings applied. No Work was replayed.': ['실행 설정을 적용했어요. 업무는 다시 실행하지 않았어요.', 'Saved execution settings applied. No work was replayed.'],
  'Applying runtime settings failed. The previous runtime was preserved or restored; no Work was replayed.': ['설정을 적용하지 못했어요. 이전 실행 환경은 보존하거나 복구했고, 업무는 다시 실행하지 않았어요.', 'Could not apply settings. The previous execution environment was preserved or restored. No work was replayed.'],
  'Applying runtime settings failed. Recovery needs review; no Work was replayed.': ['설정을 적용하지 못했어요. 복구 상태를 확인해 주세요. 업무는 다시 실행하지 않았어요.', 'Could not apply settings. Check the recovery status. No work was replayed.'],
};

/** These substitutions run only on registered product phrases, never arbitrary text. */
function koreanDescription(source: string): string {
  return source.replace(/\bWork\b/gu, '업무').replace(/완료조건|완료 조건/gu, '완료 기준')
    .replace(/클라이언트가/gu, '앱이').replace(/클라이언트를/gu, '앱을').replace(/클라이언트는/gu, '앱은')
    .replace(/클라이언트/gu, '앱').replace(/실행기/gu, '실행 도구')
    .replace(/작업 지침|작업지침/gu, '업무 지침').replace(/\bworker\b/gu, '에이전트')
    .replace(/관측되지 않았습니다/gu, '확인되지 않았어요').replace(/관측된/gu, '확인된')
    .replace(/관측합니다/gu, '확인해요').replace(/관측입니다/gu, '확인 기록이에요')
    .replace(/할 수 없습니다/gu, '할 수 없어요').replace(/할 수 있습니다/gu, '할 수 있어요')
    .replace(/못했습니다/gu, '못했어요').replace(/했습니다/gu, '했어요')
    .replace(/되었습니다/gu, '됐어요').replace(/됐습니다/gu, '됐어요')
    .replace(/마쳤습니다/gu, '마쳤어요').replace(/만들었습니다/gu, '만들었어요')
    .replace(/바뀌었습니다/gu, '바뀌었어요').replace(/않았습니다/gu, '않았어요')
    .replace(/껐습니다/gu, '껐어요').replace(/멈췄습니다/gu, '멈췄어요')
    .replace(/미뤘습니다/gu, '미뤘어요').replace(/켰습니다/gu, '켰어요')
    .replace(/끊었습니다/gu, '끊었어요').replace(/끊겼습니다/gu, '끊겼어요')
    .replace(/돌렸습니다/gu, '돌렸어요').replace(/열었습니다/gu, '열었어요')
    .replace(/끝났습니다/gu, '끝났어요').replace(/불러왔습니다/gu, '불러왔어요')
    .replace(/가져왔습니다/gu, '가져왔어요').replace(/넣었습니다/gu, '넣었어요')
    .replace(/걸렸습니다/gu, '걸렸어요').replace(/큽니다/gu, '커요')
    .replace(/열립니다/gu, '열려요').replace(/다릅니다/gu, '달라요')
    .replace(/합니다/gu, '해요').replace(/됩니다/gu, '돼요')
    .replace(/있습니다/gu, '있어요').replace(/없습니다/gu, '없어요')
    .replace(/않습니다/gu, '않아요').replace(/아닙니다/gu, '아니에요')
    // Verbs that end in -입니다 are not the copula: 쌓입니다 is 쌓여요, never 쌓이에요.
    .replace(/쓰입니다/gu, '쓰여요').replace(/움직입니다/gu, '움직여요').replace(/([쌓붙높])입니다/gu, '$1여요').replace(/(^|\s)보입니다/gu, '$1보여요')
    .replace(/([가-힣])입니다/gu, (_,last: string) => last + ((last.charCodeAt(0)-0xac00)%28===0?'예요':'이에요'))
    .replace(/보냅니다/gu, '보내요').replace(/남습니다/gu, '남아요')
    .replace(/넘깁니다/gu, '넘겨요').replace(/남깁니다/gu, '남겨요')
    .replace(/이어갑니다|이어 갑니다/gu, '이어가요').replace(/기다립니다/gu, '기다려요')
    .replace(/막습니다/gu, '막아요').replace(/바꿉니다/gu, '바꿔요')
    .replace(/바뀝니다/gu, '바뀌어요').replace(/켭니다/gu, '켜요')
    .replace(/맡습니다/gu, '맡아요').replace(/둡니다/gu, '둬요').replace(/따릅니다/gu, '따라요')
    .replace(/씁니다/gu, '사용해요')
    .replace(/듭니다/gu, '들어요').replace(/읽습니다/gu, '읽어요')
    .replace(/부릅니다/gu, '불러요').replace(/사라집니다/gu, '사라져요');
}
function englishDescription(source: string): string {
  const result = source.replace(/\bWorks\b/gu, 'work items').replace(/\bWork\b/gu, 'work')
    .replace(/\bexecutor\b/giu, 'execution tool').replace(/\bclient\b/giu, 'app')
    .replace(/completion (?:checks|conditions)/giu, 'completion criteria');
  return /^[A-Z]/u.test(source) ? result.charAt(0).toUpperCase() + result.slice(1) : result;
}

/** English display copy follows the writing rules of ASD-STE100 (Simplified Technical English) most of the way:
 * one word for one thing, approved plain verbs, simple tenses, one instruction in a sentence. The rules run on the
 * finished English of every registered phrase, reviewed or generated, so the wording stays the same everywhere.
 * Each rule leaves its own result unchanged, so the pass is safe to run twice. */
const ING: Record<string, string> = {analyzing: 'analyzes', choosing: 'chooses', organizing: 'organizes', processing: 'processes', planning: 'plans',
  continuing: 'continues', waiting: 'waits', checking: 'checks', reading: 'reads', preparing: 'prepares', starting: 'starts',
  loading: 'loads', saving: 'saves', sending: 'sends', connecting: 'connects', collecting: 'collects', writing: 'writes', using: 'uses'};
export function plainEnglish(source: string): string {
  const keepCase = (from: string, to: string) => /^[A-Z]/u.test(from) ? to.charAt(0).toUpperCase() + to.slice(1) : to;
  return source
    // One word for one thing: the noun is "sign-in", the verb is "sign in".
    .replace(/\b[Ll]og in to\b/gu, match => keepCase(match, 'sign in to')).replace(/\b[Ll]og in\b/gu, match => keepCase(match, 'sign in'))
    .replace(/\b[Ll]ogins\b/gu, match => keepCase(match, 'sign-ins')).replace(/\b[Ll]ogin\b/gu, match => keepCase(match, 'sign-in'))
    // Plain verbs.
    .replace(/\b[Uu]nverified\b/gu, match => keepCase(match, 'unconfirmed')).replace(/\b[Vv]erified\b/gu, match => keepCase(match, 'confirmed'))
    .replace(/\b[Vv]erification\b/gu, match => keepCase(match, 'confirmation')).replace(/\b[Vv]erifying\b/gu, match => keepCase(match, 'checking'))
    .replace(/\b[Vv]erif(y|ies)\b/gu, (match, end: string) => keepCase(match, end === 'y' ? 'check' : 'checks'))
    .replace(/\b(You|you|We|we|I|It|it|user|owner|AI) selected\b/gu, '$1 chose').replace(/\b[Ss]elected\b/gu, match => keepCase(match, 'chosen')).replace(/\b[Ss]elect(s?)\b/gu, (match, end: string) => keepCase(match, 'choose' + end))
    .replace(/\b(is|are|not|the|a|no|any|every|each) required\b/gu, '$1 necessary').replace(/\b[Rr]equired\b/gu, match => keepCase(match, 'needed'))
    .replace(/\b[Rr]equire(s?)\b/gu, (match, end: string) => keepCase(match, 'need' + end))
    .replace(/\b(is|are) (not )?retained\b/gu, '$1 $2kept').replace(/\b[Rr]etain(s?)\b/gu, (match, end: string) => keepCase(match, 'keep' + end))
    .replace(/\b[Rr]emain(s?)\b/gu, (match, end: string) => keepCase(match, 'stay' + end))
    .replace(/\bmay (?:require|need) /gu, 'sometimes need ').replace(/\bmay (?!not\b)/gu, 'can ')
    // Simple tenses instead of perfect and progressive forms.
    .replace(/\b(has|have) (not |never |already )?been ([a-z]+(?:ed|en|wn|pt|nt|ut|un|et))\b/gu, (_, verb: string, adverb: string | undefined, participle: string) => (verb === 'has' ? 'is ' : 'are ') + (adverb === 'already ' ? '' : adverb ?? '') + participle)
    .replace(/\bwhile work is running\b/gu, 'while work runs')
    .replace(/\b(is|are) (still |now |already )?([a-z]+ing)\b/gu, (match, verb: string, _adverb: string | undefined, form: string) => {
      const simple = ING[form]; return simple ? (verb === 'are' ? simple.replace(/(?:es|s)$/u, form === 'analyzing' || form === 'processing' || form === 'organizing' ? 'e' : '') : simple) : match; })
    // One instruction in a sentence.
    .replace(/^((?:[A-Z][a-z]+)(?: [^.,;]+)?), then ([a-z])/u, (_, first: string, next: string) => first + '. Then ' + next);
}
/** Legacy Korean and English messages remain valid keys, including persisted setup logs.
 * Aliases are idempotent, so a MutationObserver cannot rewrite the same node forever. */
export function buildCopyCatalog(source: Record<string, string>): {ko: Record<string, string>; en: Record<string, string>} {
  const ko: Record<string, string> = {}, en: Record<string, string> = {};
  for (const [key, originalEnglish] of Object.entries(source)) {
    const copy = reviewedCopy[key] ?? [koreanDescription(key), englishDescription(originalEnglish)];
    ko[key] = copy[0]; en[key] = plainEnglish(copy[1]);
  }
  for (const [key, copy] of Object.entries(reviewedCopy)) { ko[key] = copy[0]; en[key] = plainEnglish(copy[1]); }
  // Canonical display phrases must never be transformed again. Preserve original keys first.
  const canonicalKorean = new Set(Object.values(ko)), canonicalEnglish = new Set(Object.values(en));
  for (const [key, originalEnglish] of Object.entries(source)) {
    if (!Object.hasOwn(en, originalEnglish) && !canonicalEnglish.has(originalEnglish)) en[originalEnglish] = en[key]!;
  }
  for (const value of canonicalKorean) ko[value] = value;
  for (const [key, value] of Object.entries(ko)) if (!Object.hasOwn(en, value)) en[value] = en[key] ?? value;
  // Unknown English already passes through; do not duplicate every canonical label.
  for (const value of canonicalEnglish) if (Object.hasOwn(en, value)) en[value] = value;
  return {ko, en};
}
