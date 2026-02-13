set -e

BASE_DOMAIN="${1:-127.0.0.1.nip.io}"
API="http://api.${BASE_DOMAIN}"

echo "Health"
curl -s "${API}/healthz"
echo

echo "Create store"
STORE_ID=$(curl -s -X POST "${API}/stores" -H "content-type: application/json" -d '{"engine":"woocommerce"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "STORE_ID=${STORE_ID}"
echo

echo "Wait Ready"
for i in $(seq 1 240); do
  STATUS=$(curl -s "${API}/stores" | tr -d '\n' | sed -n "s/.*\"id\":\"${STORE_ID}\".*\"status\":\"\\([^\"]*\\)\".*/\\1/p")
  if [ "${STATUS}" = "Ready" ]; then
    echo "Ready"
    break
  fi
  if [ "${STATUS}" = "Failed" ]; then
    echo "Failed"
    curl -s "${API}/stores/${STORE_ID}/events"
    exit 1
  fi
  sleep 2
done
echo

echo "Links"
curl -s "${API}/stores/${STORE_ID}/links"
echo
echo "Credentials"
curl -s "${API}/stores/${STORE_ID}/credentials"
echo
echo

echo "Isolation commands"
echo "kubectl get ns | grep store-${STORE_ID}"
echo "kubectl describe quota -n store-${STORE_ID}"
echo "kubectl describe limitrange -n store-${STORE_ID}"
echo "kubectl get networkpolicy -n store-${STORE_ID}"
echo "kubectl get secret -n store-${STORE_ID}"
echo

echo "Delete store"
curl -s -X DELETE "${API}/stores/${STORE_ID}"
echo
