#!/bin/sh
set -eu

artifact="$1"
export XSCS_HOME=/tmp/xscs
export XSCS_DISTILLER=none

"$artifact" doctor >/tmp/doctor
"$artifact" remember --title "Linux artifact smoke" --body "Native container validation." --json | grep -q '"created": true'
"$artifact" search "artifact smoke" --json | grep -q 'Linux artifact smoke'
printf '%s' '{"session_id":"linux-hook","cwd":"/tmp","hook_event_name":"SessionStart"}' \
    | "$artifact" hook --event SessionStart --agent codex --no-background >/tmp/hook.json
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
    | "$artifact" mcp | grep -q '"protocolVersion"'
"$artifact" init --user --json | grep -q "$artifact"

"$artifact" serve --port 24319 --no-open >/tmp/dashboard.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT INT TERM

fetch_http() {
    timeout 2 perl -MIO::Socket::INET -e '
        my $socket = IO::Socket::INET->new(
            PeerAddr => "127.0.0.1",
            PeerPort => 24319,
            Proto => "tcp",
        ) or exit 1;
        print $socket "GET $ARGV[0] HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
        print while <$socket>;
    ' "$1"
}

dashboard_shell=''
attempt=0
while [ "$attempt" -lt 50 ]; do
    if dashboard_shell=$(fetch_http / 2>/dev/null); then
        break
    fi
    attempt=$((attempt + 1))
    sleep 0.05
done
printf '%s' "$dashboard_shell" | grep -q '/app.js'
dashboard_client=$(fetch_http /app.js)
[ "${#dashboard_client}" -gt 1000 ]

kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
trap - EXIT INT TERM

echo "linux artifact smoke passed: $artifact"
