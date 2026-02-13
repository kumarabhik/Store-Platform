set -e

BASE_DOMAIN="${1:-127.0.0.1.nip.io}"
API="http://api.${BASE_DOMAIN}"

echo "Health:"
curl -s "${API}/healthz"
echo

echo "Stores:"
curl -s "${API}/stores"
echo

echo "Replace STORE_ID then run:"
echo "kubectl get ns | grep store-"
echo "kubectl describe quota -n store-STORE_ID"
echo "kubectl describe limitrange -n store-STORE_ID"
echo "kubectl get networkpolicy -n store-STORE_ID"
echo "kubectl get secret -n store-STORE_ID"
echo "curl -s ${API}/stores/STORE_ID/summary"
echo "open http://store-STORE_ID.${BASE_DOMAIN}"
