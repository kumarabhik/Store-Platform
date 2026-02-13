import os
from pydantic import BaseModel
class Settings(BaseModel):
    base_domain: str = os.getenv("BASE_DOMAIN", "127.0.0.1.nip.io")
    ingress_class_name: str = os.getenv("INGRESS_CLASS_NAME", "nginx")
    db_path: str = os.getenv("DB_PATH", "/data/platform.db")
    stores_namespace_prefix: str = os.getenv("STORES_NAMESPACE_PREFIX", "store")
    store_chart_path: str = os.getenv("STORE_CHART_PATH", "/charts/store-woocommerce")
    use_helm_binary: bool =True
    
settings = Settings()

