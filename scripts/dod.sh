#!/usr/bin/env bash
# Definition-of-done checks (ROADMAP P9 tracker), end to end against a running install.
# Each line prints PASS or FAIL; the script exits non-zero if anything failed.
#
# Two existing accounts are needed: user A (admin, uses the chat) and user B (member, uses /mcp
# with an API key, like Claude Code would). Give either email + password or a session token:
#   DOD_ADMIN_EMAIL / DOD_ADMIN_PASSWORD   or  DOD_ADMIN_TOKEN
#   DOD_MEMBER_EMAIL / DOD_MEMBER_PASSWORD or  DOD_MEMBER_TOKEN
# Options: API (default http://api.127.0.0.1.nip.io:8088), SKIP_CHAT=1 (no LLM calls),
#          SKIP_K8S=1 (don't scale pods; e.g. without kubectl access).
# Requires: curl, node, kubectl (unless SKIP_K8S), and scripts/verify-store.sh's requirements.
#
# What it can't do: drive Claude Code itself. "One prompt that uses two upstreams" is checked as
# "user B's key can call tools of two upstreams"; the prompt is shown live in the demo.
set -uo pipefail

cd "$(dirname "$0")/.."
API="${API:-http://api.127.0.0.1.nip.io:8088}"
CURL=(curl -sS --max-time 150)
failures=0
stamp=$(date +%H%M%S)

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; failures=$((failures + 1)); }
# json '<js expression on j>' < body. Prints "" instead of crashing on bad input.
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=eval(process.argv[1]);console.log(v===undefined?'':typeof v==='object'?JSON.stringify(v):v)}catch{console.log('')}})" "$1"; }

session() {  # session <EMAIL_VAR> <PASSWORD_VAR> <TOKEN_VAR>
  local token="${!3:-}"
  if [ -z "$token" ]; then
    [ -n "${!1:-}" ] && [ -n "${!2:-}" ] || { echo "set $1 and $2, or $3" >&2; exit 2; }
    token=$("${CURL[@]}" -H 'Content-Type: application/json' -d "{\"email\":\"${!1}\",\"password\":\"${!2}\"}" "$API/auth/login" | json 'j.token')
    [ -n "$token" ] || { echo "login failed for ${!1}" >&2; exit 2; }
  fi
  echo "$token"
}
A=$(session DOD_ADMIN_EMAIL DOD_ADMIN_PASSWORD DOD_ADMIN_TOKEN)
B=$(session DOD_MEMBER_EMAIL DOD_MEMBER_PASSWORD DOD_MEMBER_TOKEN)

as() { local t=$1; shift; "${CURL[@]}" -H "Authorization: Bearer $t" -H 'Content-Type: application/json' "$@"; }
mcp() {  # mcp <key> <method> [params-json]  -> JSON-RPC response body
  "${CURL[@]}" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-{\}}}" "$API/mcp"
}
call() { mcp "$1" tools/call "{\"name\":\"$2\",\"arguments\":$3}"; }
tool_prefixes() { json '[...new Set((j.result?.tools||[]).map(t=>t.name.split("__")[0]))].sort().join(",")'; }
server_id() { as "$A" "$API/api/servers" | json "j.servers.find(s=>s.slug==='$1').id"; }
# Chat as user A; prints the SSE stream.
chat() { as "$A" -H 'Accept: text/event-stream' -d "{\"messages\":[{\"role\":\"user\",\"content\":\"$1\"}]}" "$API/api/chat"; }

A_EMAIL=$(as "$A" "$API/auth/me" | json 'j.user.email')
B_EMAIL=$(as "$B" "$API/auth/me" | json 'j.user.email')
[ "$(as "$A" "$API/auth/me" | json 'j.user.role')" = admin ] || { echo "user A ($A_EMAIL) must be an admin" >&2; exit 2; }
echo "user A = $A_EMAIL (admin, chat), user B = $B_EMAIL (API key)"
echo

# 1. Storefront checkout with Cash on delivery, order visible in WooCommerce.
store_out=$(bash scripts/verify-store.sh 2>&1)
order_id=$(echo "$store_out" | sed -n 's/.*-> order #\([0-9]*\).*/\1/p' | head -1)
if [ -n "$order_id" ] && ! echo "$store_out" | grep -q '^FAIL'; then
  pass "storefront COD checkout -> order #$order_id, present in WooCommerce"
else
  fail "storefront checkout: $(echo "$store_out" | grep FAIL)"
fi

# 2. User B: a key and the gateway URL are enough to see every enabled, connected server's tools.
created=$(as "$B" -d "{\"name\":\"dod-$stamp\"}" "$API/api/keys")
KEY=$(echo "$created" | json 'j.key'); KEY_ID=$(echo "$created" | json 'j.id')
# Probe every enabled server first, so "Connected" is current and not left over from earlier.
for id in $(as "$A" "$API/api/servers" | json 'j.servers.filter(s=>s.enabled).map(s=>s.id).join(" ")'); do
  as "$A" -X POST -d '{}' "$API/api/servers/$id/test" >/dev/null
done
expected=$(as "$A" "$API/api/servers" | json 'j.servers.filter(s=>s.enabled&&s.status==="Connected"&&s.tools.length).map(s=>s.slug).sort().join(",")')
got=$(mcp "$KEY" tools/list | tool_prefixes)
[ -n "$got" ] && [ "$got" = "$expected" ] && pass "user B tools/list shows every enabled server: $got" || fail "user B tools/list: got '$got', expected '$expected'"

# 2b. Tool permissions (S2): a member reads the store but can't change it. The write tool is
# missing from B's list and a direct call is refused like an unknown tool (and audited as denied).
listed=$(mcp "$KEY" tools/list | json '(j.result?.tools||[]).some(t=>t.name==="woo__create_product")')
refused=$(call "$KEY" woo__create_product '{"name":"dod-sneaky","regular_price":"1"}' | json 'j.error?.message||""')
[ "$listed" = false ] && [[ "$refused" == *"Unknown tool"* ]] && pass "user B (member) can't see or call woo__create_product" \
  || fail "member write access: listed=$listed refused='$refused'"

# 3. User B: "what orders came in today?" (the tool an MCP client picks for it).
orders=$(call "$KEY" woo__list_orders '{"date":"today"}' | json '(j.result?.structuredContent?.orders||[]).map(o=>o.id).join(",")')
[[ ",$orders," == *",$order_id,"* ]] && pass "user B woo__list_orders today includes order #$order_id" || fail "user B orders today: '$orders' (expected #$order_id)"

# 4. User B: tools of two different upstreams with the same key.
note=$(call "$KEY" notes__add_note "{\"title\":\"Follow-up for order #$order_id\",\"body\":\"dod.sh $stamp\",\"tags\":[\"follow-up\",\"order-$order_id\"]}")
[ "$(echo "$note" | json 'j.result && !j.result.isError')" = true ] && pass "user B notes__add_note (second upstream) ok" || fail "user B notes__add_note: $note"

# 5-6. User A (chat): create a product, see it on the storefront; ask about today's orders.
if [ "${SKIP_CHAT:-}" != 1 ]; then
  product="DoD Mug $stamp"
  # Name the store: with provisioned stores connected too, "create a product" alone is ambiguous.
  stream=$(chat "In the default store (the woo tools), create a product called $product priced 499 rupees.")
  if echo "$stream" | grep -q '"name":"woo__create_product","ok":true'; then
    found=$(curl -sS --max-time 30 --resolve store.127.0.0.1.nip.io:8088:127.0.0.1 -G --data-urlencode "search=$product" \
      "${STORE_URL:-http://store.127.0.0.1.nip.io:8088}/wp-json/wc/store/v1/products" | json 'j.map(p=>p.name+" "+p.prices.price/10**p.prices.currency_minor_unit).join(",")')
    [[ "$found" == "$product 499"* ]] && pass "user A chat created '$product' for 499, visible on the storefront" || fail "chat product not on storefront: '$found'"
  else
    fail "user A chat create_product: $(echo "$stream" | grep -E 'event: (error|message)' -A1 | tail -1)"
  fi
  answer=$(chat "What orders came in today in the default store (the woo tools)?" | grep '^data: {"type":"message"' | cut -c7- | json 'j.text')
  [[ "$answer" == *"$order_id"* ]] && pass "user A chat 'orders today' mentions order #$order_id" || fail "chat answer doesn't mention #$order_id: ${answer:0:200}"
else
  echo "SKIP  chat checks (SKIP_CHAT=1)"
fi

# 7. Disable an upstream -> its tools disappear for clients (the chat uses the same listTools).
NOTES=$(server_id notes)
as "$A" -X PATCH -d '{"enabled":false}' "$API/api/servers/$NOTES" >/dev/null
got=$(mcp "$KEY" tools/list | tool_prefixes)
[[ ",$got," != *",notes,"* ]] && pass "notes disabled -> user B sees $got" || fail "notes disabled but still listed: $got"
as "$A" -X PATCH -d '{"enabled":true}' "$API/api/servers/$NOTES" >/dev/null
as "$A" -X POST -d "{}" "$API/api/servers/$NOTES/test" >/dev/null

# 8. Kill an upstream pod -> others keep working, the server shows Unreachable with a reason.
if [ "${SKIP_K8S:-}" != 1 ]; then
  kubectl -n mcp-servers scale deploy/notes-mcp --replicas=0 >/dev/null
  kubectl -n mcp-servers wait --for=delete pod -l app.kubernetes.io/component=notes-mcp --timeout=60s >/dev/null 2>&1
  probe=$(as "$A" -X POST -d "{}" "$API/api/servers/$NOTES/test")
  status=$(echo "$probe" | json 'j.server.status'); reason=$(echo "$probe" | json 'j.server.last_error')
  [ "$status" = Unreachable ] && pass "notes-mcp killed -> Unreachable: $reason" || fail "notes-mcp killed but status is '$status'"
  woo=$(call "$KEY" woo__get_store_info '{}' | json 'j.result && !j.result.isError')
  [ "$woo" = true ] && pass "woo still answers while notes is down" || fail "woo failed while notes is down"
  kubectl -n mcp-servers scale deploy/notes-mcp --replicas=1 >/dev/null
  kubectl -n mcp-servers rollout status deploy/notes-mcp --timeout=120s >/dev/null
  status=$(as "$A" -X POST -d "{}" "$API/api/servers/$NOTES/test" | json 'j.server.status')
  [ "$status" = Connected ] && pass "notes-mcp back -> Connected" || fail "notes-mcp back but status is '$status'"
else
  echo "SKIP  kill-an-upstream check (SKIP_K8S=1)"
fi

# 9. Revoke B's key -> the very next call is rejected.
as "$B" -X DELETE "$API/api/keys/$KEY_ID" >/dev/null
code=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$API/mcp")
[ "$code" = 401 ] && pass "B's key revoked -> next /mcp call HTTP 401" || fail "revoked key got HTTP $code"

# 10. Every call above is in the audit log under the right user.
b_rows=$(as "$A" "$API/api/audit?user=$B_EMAIL&source=mcp&limit=50" | json 'j.rows.map(r=>r.exposed_name+":"+r.outcome).join(" ")')
for want in "woo__list_orders:ok" "notes__add_note:ok" "woo__create_product:denied" "woo__get_store_info:ok"; do
  [ "$want" = "woo__get_store_info:ok" ] && [ "${SKIP_K8S:-}" = 1 ] && continue
  [[ " $b_rows " == *" $want "* ]] && pass "audit: $want under $B_EMAIL (mcp)" || fail "audit: no $want under $B_EMAIL"
done
if [ "${SKIP_CHAT:-}" != 1 ]; then
  a_rows=$(as "$A" "$API/api/audit?user=$A_EMAIL&source=chat&limit=20" | json 'j.rows.map(r=>r.exposed_name+":"+r.outcome).join(" ")')
  for want in "woo__create_product:ok" "woo__list_orders:ok"; do
    [[ " $a_rows " == *" $want "* ]] && pass "audit: $want under $A_EMAIL (chat)" || fail "audit: no $want under $A_EMAIL"
  done
fi

echo
[ "$failures" -eq 0 ] && echo "Definition of done: all checks passed." || { echo "Definition of done: $failures check(s) failed."; exit 1; }
