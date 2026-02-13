1) Open dashboard
- Create store
- Wait status Ready

2) Show isolation
- kubectl get ns | grep store-
- kubectl describe quota -n store-<id>

3) Open store URL
- Login WP admin
- Add a product
- Checkout with dummy/COD
- Show order in WooCommerce admin

4) Delete store
- Click delete
- kubectl get ns | grep store-<id> (should be gone)
