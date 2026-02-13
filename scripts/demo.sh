set -e

BASE_DOMAIN="${1:-127.0.0.1.nip.io}"

echo "API health:"
curl -s "http://api.${BASE_DOMAIN}/healthz"
echo

echo "Create store:"
STORE_ID=$(curl -s -X POST "http://api.${BASE_DOMAIN}/stores" -H "content-type: application/json" -d '{"engine":"woocommerce"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "STORE_ID=$STORE_ID"

echo "Open store:"
echo "http://store-${STORE_ID}.${BASE_DOMAIN}"

echo "Watch events:"
curl -s "http://api.${BASE_DOMAIN}/stores/${STORE_ID}/events"
echo
