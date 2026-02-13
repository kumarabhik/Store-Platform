set -e

BASE_DOMAIN="${1:-127.0.0.1.nip.io}"
API="http://api.${BASE_DOMAIN}"

STORE_ID=$(curl -s -X POST "${API}/stores" -H "content-type: application/json" -d '{"engine":"woocommerce"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "STORE_ID=${STORE_ID}"
echo "STORE_URL=http://store-${STORE_ID}.${BASE_DOMAIN}"

echo "Waiting for Ready..."
for i in $(seq 1 180); do
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

echo "Credentials:"
curl -s "${API}/stores/${STORE_ID}/credentials"
echo

echo "Deleting..."
curl -s -X DELETE "${API}/stores/${STORE_ID}"
echo

echo "Done"
