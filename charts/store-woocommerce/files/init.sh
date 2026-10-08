#!/bin/sh
# Idempotent store setup. Runs as a Helm post-install/post-upgrade hook in the WP-CLI image,
# sharing the WordPress volume (same wp-config.php) and DB credentials. Every step checks first.
set -eu

log() { echo "[store-init] $*"; }

cd /var/www/html

# WP-CLI only writes .htaccess rewrite rules if it believes mod_rewrite is loaded.
export WP_CLI_CONFIG_PATH=/tmp/wp-cli.yml
printf 'apache_modules:\n  - mod_rewrite\n' > "$WP_CLI_CONFIG_PATH"

log "waiting for WordPress files (the wordpress container copies them on first start)"
i=0
until [ -f wp-config.php ]; do
  i=$((i + 1)); [ "$i" -gt 120 ] && { log "ERROR: wp-config.php did not appear within 10 minutes"; exit 1; }
  sleep 5
done

log "waiting for the database"
i=0
until wp db query "SELECT 1" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 120 ] && { log "ERROR: database not reachable within 10 minutes"; exit 1; }
  sleep 5
done

if wp core is-installed 2>/dev/null; then
  log "WordPress already installed"
else
  log "installing WordPress"
  wp core install --url="$STORE_URL" --title="$SITE_TITLE" \
    --admin_user="$ADMIN_USER" --admin_password="$ADMIN_PASSWORD" --admin_email="$ADMIN_EMAIL" --skip-email
fi

# Re-applied every run so a changed publicUrl (domain/port) takes effect on helm upgrade.
wp option update home "$STORE_URL" >/dev/null
wp option update siteurl "$STORE_URL" >/dev/null
wp option update timezone_string "$TIMEZONE" >/dev/null
wp rewrite structure '/%postname%/' --hard >/dev/null

if ! wp plugin is-installed woocommerce; then
  log "installing WooCommerce ${WC_VERSION:-latest}"
  if [ -n "${WC_VERSION:-}" ]; then
    wp plugin install woocommerce --version="$WC_VERSION"
  else
    wp plugin install woocommerce
  fi
fi
wp plugin is-active woocommerce || wp plugin activate woocommerce

log "configuring WooCommerce"
wp option update woocommerce_currency "$CURRENCY" >/dev/null
wp option update woocommerce_default_country "$DEFAULT_COUNTRY" >/dev/null
# New stores start in "coming soon" mode, which hides the storefront from visitors (SYSTEM.md G13).
wp option update woocommerce_coming_soon no >/dev/null
wp option update woocommerce_store_pages_only no >/dev/null
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json >/dev/null
# No shipping zones are configured, so turn shipping off; otherwise checkout fails with
# "no shipping options available" for physical products.
wp option update woocommerce_ship_to_countries disabled >/dev/null
# Cash on delivery: the test-friendly payment method for the demo checkout.
wp option update woocommerce_cod_settings \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}' \
  --format=json >/dev/null
wp wc tool run install_pages --user="$ADMIN_USER" >/dev/null

log "ensuring REST API key for the MCP server"
wp eval-file /init/api-key.php

if [ "$SEED_PRODUCTS" = "true" ]; then
  count=$(wp wc product list --user="$ADMIN_USER" --format=count)
  if [ "$count" = "0" ]; then
    log "seeding starter products"
    wp wc product create --user="$ADMIN_USER" --name="Classic Tee" --regular_price=499 --status=publish \
      --short_description="Soft cotton tee." >/dev/null
    wp wc product create --user="$ADMIN_USER" --name="Canvas Tote" --regular_price=299 --status=publish \
      --short_description="Everyday tote bag." >/dev/null
    wp wc product create --user="$ADMIN_USER" --name="Ceramic Mug" --regular_price=199 --status=publish \
      --short_description="350 ml stoneware mug." >/dev/null
  else
    log "products already exist ($count), skipping seed"
  fi
fi

log "done: $STORE_URL"
