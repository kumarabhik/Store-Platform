1) Get summary
- GET /stores/:id/summary
- Note wordpressUsername + wordpressPassword

2) Open store
- http://store-<id>.<baseDomain>

3) Open admin
- http://store-<id>.<baseDomain>/wp-admin
- login with admin + password

4) Verify WooCommerce
- Plugins -> Installed Plugins -> WooCommerce active

5) Add a product
- Products -> Add New
- Set name + price
- Publish

6) Place order
- Open storefront
- Add product to cart
- Checkout
- Choose COD/dummy method if available
- Place order

7) Verify order exists
- WooCommerce -> Orders
- Confirm new order visible
