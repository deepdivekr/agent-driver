#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly AGENT_DRIVER_NODE_VERSION="22.22.0"
readonly AGENT_DRIVER_NPM_VERSION="11.11.0"
readonly DEFAULT_REPOSITORY="https://github.com/deepdivekr/agent-driver.git"

say() { printf '[agent-driver] %s\n' "$1"; }
fail() { printf '[agent-driver] 설치 중단: %s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 명령이 필요합니다."; }

[[ "$(uname -s)" == "Linux" ]] || fail "현재 자동 설치는 Ubuntu/Linux와 WSL만 지원합니다."
[[ -n "${HOME:-}" && "$HOME" == /* && "$HOME" != "/" ]] || fail "안전한 HOME 경로를 확인할 수 없습니다."

readonly REPOSITORY_URL="${AGENT_DRIVER_REPOSITORY_URL:-$DEFAULT_REPOSITORY}"
readonly REPOSITORY_REF="${AGENT_DRIVER_VERSION:-v0.2.0}"
readonly INSTALL_DIR="${AGENT_DRIVER_INSTALL_DIR:-$HOME/.local/share/agent-driver}"
readonly BIN_DIR="${AGENT_DRIVER_BIN_DIR:-$HOME/.local/bin}"
readonly RUNTIME_DIR="${AGENT_DRIVER_RUNTIME_DIR:-$HOME/.local/share/agent-driver-runtime}"

if [[ "$REPOSITORY_URL" != "$DEFAULT_REPOSITORY" ]]; then
  [[ "${AGENT_DRIVER_ALLOW_LOCAL_FIXTURE:-0}" == "1" && "$REPOSITORY_URL" == file:///* ]] || fail "공식 Agent Driver 저장소만 자동 설치할 수 있습니다."
fi

safe_home_path() {
  local target="$1" parent resolved_home resolved_parent resolved_target
  [[ "$target" == /* && "$target" != "/" && "$target" != *$'\n'* && "$target" != *$'\r'* ]] || fail "설치 경로가 안전하지 않습니다."
  resolved_home="$(readlink -f -- "$HOME")"
  resolved_target="$(readlink -m -- "$target")"
  [[ "$resolved_target" == "$resolved_home/"* ]] || fail "설치 경로는 사용자 HOME 내부여야 합니다: $target"
  [[ ! -L "$target" ]] || fail "심볼릭 링크에는 설치하지 않습니다: $target"
  mkdir -p -- "$(dirname -- "$target")"
  parent="$(dirname -- "$target")"
  resolved_parent="$(readlink -f -- "$parent")"
  resolved_target="$resolved_parent/$(basename -- "$target")"
  [[ "$resolved_target" == "$resolved_home/"* ]] || fail "설치 경로는 사용자 HOME 내부여야 합니다: $target"
}

for tool in git curl tar sha256sum readlink; do need "$tool"; done
safe_home_path "$INSTALL_DIR"
safe_home_path "$BIN_DIR"
safe_home_path "$RUNTIME_DIR"
mkdir -p -- "$BIN_DIR" "$RUNTIME_DIR"

node_version() { "$1" --version 2>/dev/null | sed 's/^v//'; }
node_bin="${AGENT_DRIVER_NODE_BIN:-}"
if [[ -n "$node_bin" ]]; then
  [[ "$node_bin" == /* && -x "$node_bin" && ! -L "$node_bin" ]] || fail "지정한 Node 실행 파일이 안전하지 않습니다."
elif command -v node >/dev/null 2>&1 && [[ "$(node_version "$(command -v node)")" == "$AGENT_DRIVER_NODE_VERSION" ]]; then
  node_bin="$(readlink -f -- "$(command -v node)")"
else
  case "$(uname -m)" in
    x86_64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *) fail "지원하지 않는 CPU 아키텍처입니다: $(uname -m)" ;;
  esac
  node_name="node-v${AGENT_DRIVER_NODE_VERSION}-linux-${node_arch}"
  node_root="$RUNTIME_DIR/$node_name"
  safe_home_path "$node_root"
  if [[ ! -x "$node_root/bin/node" ]]; then
    say "Node.js ${AGENT_DRIVER_NODE_VERSION} 준비"
    temporary="$(mktemp -d "$RUNTIME_DIR/.node-install.XXXXXX")"
    trap 'rm -rf -- "${temporary:-}"' EXIT
    base_url="https://nodejs.org/dist/v${AGENT_DRIVER_NODE_VERSION}"
    archive_name="${node_name}.tar.xz"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$base_url/SHASUMS256.txt" --output "$temporary/SHASUMS256.txt"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$base_url/$archive_name" --output "$temporary/$archive_name"
    expected="$(awk -v file="$archive_name" '$2==file {print $1}' "$temporary/SHASUMS256.txt")"
    [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || fail "Node.js checksum을 확인할 수 없습니다."
    printf '%s  %s\n' "$expected" "$temporary/$archive_name" | sha256sum --check --status - || fail "Node.js checksum이 일치하지 않습니다."
    tar -xJf "$temporary/$archive_name" -C "$temporary"
    [[ -x "$temporary/$node_name/bin/node" ]] || fail "Node.js 배포물 형식이 올바르지 않습니다."
    mv -- "$temporary/$node_name" "$node_root"
    rm -rf -- "$temporary"
    trap - EXIT
  fi
  node_bin="$node_root/bin/node"
fi
[[ "$(node_version "$node_bin")" == "$AGENT_DRIVER_NODE_VERSION" ]] || fail "Node.js ${AGENT_DRIVER_NODE_VERSION}이 필요합니다."

# npm and package lifecycle scripts resolve `node` through /usr/bin/env. Keep
# the selected, verified Node first for each child without changing the user's
# shell PATH or relying on an unrelated system Node installation.
readonly AGENT_DRIVER_TOOL_PATH="$(dirname -- "$node_bin"):${PATH:-}"
with_selected_node() { env PATH="$AGENT_DRIVER_TOOL_PATH" "$@"; }

if [[ -e "$INSTALL_DIR" ]]; then
  [[ -d "$INSTALL_DIR/.git" && -f "$INSTALL_DIR/.git/agent-driver-managed" ]] || fail "기존 비관리 디렉터리를 덮어쓰지 않습니다: $INSTALL_DIR"
  [[ "$(git -C "$INSTALL_DIR" remote get-url origin)" == "$REPOSITORY_URL" ]] || fail "기존 설치의 원격 저장소가 다릅니다."
  [[ -z "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=normal)" ]] || fail "기존 설치에 수정된 파일이 있어 업데이트하지 않습니다."
  say "Agent Driver 소스 업데이트"
  git -C "$INSTALL_DIR" fetch --quiet --depth 1 origin "$REPOSITORY_REF"
  git -C "$INSTALL_DIR" checkout --quiet --detach FETCH_HEAD
else
  say "Agent Driver 내려받기"
  git clone --quiet --filter=blob:none --depth 1 --branch "$REPOSITORY_REF" --single-branch "$REPOSITORY_URL" "$INSTALL_DIR"
  [[ -d "$INSTALL_DIR/.git" ]] || fail "저장소를 내려받지 못했습니다."
  printf 'format=1\nrepository=%s\n' "$REPOSITORY_URL" > "$INSTALL_DIR/.git/agent-driver-managed"
fi

base_npm=""
if [[ -x "$(dirname -- "$node_bin")/npm" ]]; then base_npm="$(dirname -- "$node_bin")/npm"; elif command -v npm >/dev/null 2>&1; then base_npm="$(command -v npm)"; else fail "npm bootstrap을 찾지 못했습니다."; fi
npm_bin="$base_npm"
if [[ "$(with_selected_node "$base_npm" --version 2>/dev/null || true)" != "$AGENT_DRIVER_NPM_VERSION" ]]; then
  npm_root="$RUNTIME_DIR/npm-${AGENT_DRIVER_NPM_VERSION}"
  safe_home_path "$npm_root"
  if [[ ! -x "$npm_root/node_modules/.bin/npm" ]]; then
    say "npm ${AGENT_DRIVER_NPM_VERSION} 준비"
    with_selected_node "$base_npm" install --silent --no-audit --no-fund --prefix "$npm_root" --no-save "npm@${AGENT_DRIVER_NPM_VERSION}"
  fi
  npm_bin="$npm_root/node_modules/.bin/npm"
fi
[[ "$(with_selected_node "$npm_bin" --version)" == "$AGENT_DRIVER_NPM_VERSION" ]] || fail "npm ${AGENT_DRIVER_NPM_VERSION}을 준비하지 못했습니다."

say "의존성 설치"
(cd "$INSTALL_DIR" && with_selected_node "$npm_bin" ci --no-audit --no-fund)
say "Agent Driver 빌드"
(cd "$INSTALL_DIR" && with_selected_node "$npm_bin" run build)
if [[ "${AGENT_DRIVER_SKIP_BROWSER_INSTALL:-0}" != "1" ]]; then
  say "전용 Chromium 준비"
  (cd "$INSTALL_DIR" && with_selected_node "$npm_bin" exec -- playwright install chromium)
  say "전용 Chromium 실행 확인"
  if ! (cd "$INSTALL_DIR" && with_selected_node "$node_bin" --input-type=module -e '
    import {chromium} from "playwright";
    const browser=await chromium.launch({headless:true,timeout:15000});
    try {
      const page=await browser.newPage();
      await page.goto("data:text/html,<title>agent-driver-browser-check</title>",{timeout:5000});
      if(await page.title()!=="agent-driver-browser-check")throw Error("BROWSER_SMOKE_TITLE_MISMATCH");
    } finally {await browser.close();}
  ') >/dev/null 2>&1; then
    printf -v browser_deps_command '%q %q install-deps chromium' "$node_bin" "$INSTALL_DIR/node_modules/playwright/cli.js"
    fail "Chromium을 실행하지 못했습니다. Ubuntu/WSL 시스템 라이브러리가 부족할 수 있습니다. 필요한 경우 '${browser_deps_command}'를 직접 실행한 뒤 설치를 다시 시도하세요. 이 명령은 시스템 패키지 설치 권한을 요청할 수 있습니다."
  fi
fi

launcher="$BIN_DIR/agent-driver"
temporary_launcher="$BIN_DIR/.agent-driver.$$.tmp"
printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' "$node_bin" "$INSTALL_DIR/dist/cli.js" > "$temporary_launcher"
chmod 0700 "$temporary_launcher"
mv -- "$temporary_launcher" "$launcher"

say "설치 완료: $launcher"
if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
  say "새 터미널에서 명령이 보이지 않으면 PATH에 $BIN_DIR 를 추가하세요."
fi
if [[ "${AGENT_DRIVER_SKIP_CONNECT:-0}" != "1" ]]; then
  say "관제센터 시작"
  "$launcher" connect
fi
