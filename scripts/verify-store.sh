#!/usr/bin/env bash
# Verifies the default store end to end (ROADMAP P1):
#   1. storefront answers through the ingress
#   2. a COD checkout through the WooCommerce Store API (what the checkout page itself calls)
#   3. the order exists in WooCommerce (same data the admin Orders page shows)
#   4. with --persistence: delete the WordPress and MariaDB pods, then re-check the order
# Requires: ingress port-forward on 127.0.0.1:8088 (ops/up.ps1 starts it), kubectl, curl, node.
set -euo pipefail

NS="${NS:-store-default}"
REL="${REL:-store-default}"
HOST="${HOST_NAME:-store.127.0.0.1.nip.io}"
PORT="${PORT:-8088}"
BASE="http://${HOST}:${PORT}"
# --resolve avoids depending on public DNS for nip.io (SYSTEM.md G12).
CURL=(curl -sS --max-time 30 --resolve "${HOST}:${PORT}:127.0.0.1")

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; exit 1; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(eval('j'+process.argv[1]))})" "$1"; }

order_status() {
  kubectl -n "$NS" exec "deploy/${REL}-wordpress" -c wordpress -- php -r '
    error_reporting(E_ERROR);
    $_SERVER["HTTP_HOST"] = "localhost";
    define("WP_USE_THEMES", false);
    require "/var/www/html/wp-load.php";
    $o = wc_get_order((int) $argv[1]);
    echo $o ? implode(" ", [$o->get_status(), $o->get_payment_method(), $o->get_total(), $o->get_currency()]) : "missing";
  ' "$1"
}

code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/")
[ "$code" = "200" ] && pass "storefront $BASE/ -> 200" || fail "storefront $BASE/ -> $code"

products=$("${CURL[@]}" "$BASE/wp-json/wc/store/v1/products?per_page=1")
product_id=$(echo "$products" | json '[0].id')
product_name=$(echo "$products" | json '[0].name')
[ -n "$product_id" ] && pass "product available: #$product_id $product_name" || fail "no products in store"

cart_token=$("${CURL[@]}" -D - -o /dev/null "$BASE/wp-json/wc/store/v1/cart" | tr -d '\r' | awk -F': ' 'tolower($1)=="cart-token"{print $2}')
[ -n "$cart_token" ] || fail "no Cart-Token header from Store API"

"${CURL[@]}" -o /dev/null -H "Cart-Token: $cart_token" -H 'Content-Type: application/json' \
  -d "{\"id\":$product_id,\"quantity\":1}" "$BASE/wp-json/wc/store/v1/cart/add-item"
pass "added #$product_id to cart"

address='"first_name":"Test","last_name":"Buyer","address_1":"1 MG Road","city":"Bengaluru","state":"KA","postcode":"560001","country":"IN","phone":"9999999999"'
checkout=$("${CURL[@]}" -H "Cart-Token: $cart_token" -H 'Content-Type: application/json' \
  -d "{\"billing_address\":{${address},\"email\":\"buyer@example.com\"},\"shipping_address\":{${address}},\"payment_method\":\"cod\"}" \
  "$BASE/wp-json/wc/store/v1/checkout")
order_id=$(echo "$checkout" | json '.order_id' 2>/dev/null || true)
[ -n "$order_id" ] && [ "$order_id" != "undefined" ] || fail "checkout failed: $checkout"
pass "checkout with Cash on delivery -> order #$order_id ($(echo "$checkout" | json '.status'))"

status=$(order_status "$order_id")
[[ "$status" == processing\ cod* || "$status" == on-hold\ cod* || "$status" == pending\ cod* ]] \
  && pass "order #$order_id in WooCommerce: $status" || fail "order #$order_id in WooCommerce: $status"

if [ "${1:-}" = "--persistence" ]; then
  echo "...deleting WordPress and MariaDB pods"
  kubectl -n "$NS" delete pod -l "app.kubernetes.io/instance=${REL},app.kubernetes.io/component in (wordpress,mariadb)" --wait=true >/dev/null
  kubectl -n "$NS" rollout status "statefulset/${REL}-mariadb" --timeout=600s >/dev/null
  kubectl -n "$NS" rollout status "deploy/${REL}-wordpress" --timeout=600s >/dev/null
  status=$(order_status "$order_id")
  [[ "$status" != missing ]] && pass "after pod restart, order #$order_id still there: $status" || fail "order #$order_id lost after pod restart"
  # The ingress may answer with an error page for a few seconds while it picks up the new pod.
  count=""
  for _ in $(seq 1 15); do
    count=$("${CURL[@]}" "$BASE/wp-json/wc/store/v1/products?per_page=100" | json '.length' 2>/dev/null) && break
    sleep 2
  done
  [ -n "$count" ] && pass "after pod restart, storefront lists $count products" || fail "storefront not answering after pod restart"
fi

echo
echo "Admin: $BASE/wp-admin  (user: admin)"
echo "Password: kubectl -n $NS get secret ${REL}-credentials -o jsonpath='{.data.wordpress-admin-password}' | base64 -d"
