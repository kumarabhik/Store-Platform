# Manual order checklist (default store)

Automated version of steps 3–5: `bash scripts/verify-store.sh` (add `--persistence` to also restart the pods).

1) Get the admin password
```powershell
kubectl -n store-default get secret store-default-credentials -o jsonpath="{.data.wordpress-admin-password}" | %{ [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) }
```

2) Open the store
- Storefront: http://store.127.0.0.1.nip.io:8088
- Admin: http://store.127.0.0.1.nip.io:8088/wp-admin (user `admin`)
- Requires the ingress port-forward on 8088 (started by `ops/up.ps1` / `ops/resume.ps1`)

3) Place an order
- Open a product (Classic Tee, Canvas Tote or Ceramic Mug) → Add to cart → View cart → Proceed to checkout
- Fill in the billing details, choose **Cash on delivery**, click **Place order**
- Note the order number on the confirmation page

4) Confirm the order in WooCommerce admin
- WooCommerce → Orders → the new order shows status **Processing**, payment method **Cash on delivery**

5) (Optional) Persistence
```powershell
kubectl -n store-default delete pod -l "app.kubernetes.io/component in (wordpress,mariadb)"
```
- Wait until pods are Running again (`kubectl -n store-default get pods`), reload Orders → the order is still there
