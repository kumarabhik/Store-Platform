from datetime import datetime
import uuid

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from .settings import settings
from .models import Base, Store
from .kube import load_kube, ensure_namespace, delete_namespace, helm_install, helm_uninstall

app = FastAPI(title="Store Provisioning API")

engine = create_engine(f"sqlite:///{settings.db_path}", echo=False)
Base.metadata.create_all(engine)

@app.on_event("startup")
def _startup():
    load_kube()

@app.get("/healthz")
def healthz():
    return {"ok": True}

class CreateStoreReq(BaseModel):
    engine: str = "woocommerce"  

@app.get("/stores")
def list_stores():
    with Session(engine) as s:
        rows = s.scalars(select(Store).order_by(Store.created_at.desc())).all()
        return [
            {
                "id": r.id,
                "engine": r.engine,
                "status": r.status,
                "url": r.url,
                "created_at": r.created_at.isoformat(),
                "last_error": r.last_error,
            }
            for r in rows
        ]

@app.post("/stores")
def create_store(req: CreateStoreReq):
    if req.engine not in ("woocommerce", "medusa"):
        raise HTTPException(status_code=400, detail="engine must be woocommerce|medusa")

    store_id = str(uuid.uuid4())[:8]
    ns = f"{settings.stores_namespace_prefix}-{store_id}"
    host = f"store-{store_id}.{settings.base_domain}"
    url = f"http://{host}"

    with Session(engine) as s:
        s.add(Store(
            id=store_id,
            engine=req.engine,
            status="Provisioning",
            url=url,
            created_at=datetime.utcnow(),
            last_error=None,
        ))
        s.commit()

    try:
        ensure_namespace(ns)

        if req.engine == "medusa":

            raise RuntimeError("Medusa stubbed for Round-1; implement in Round-2 or later.")


        release = f"wc-{store_id}"
        helm_install(
            release=release,
            chart_path=settings.store_chart_path,
            namespace=ns,
            set_values={
                "ingress.enabled": "true",
                "ingress.className": settings.ingress_class_name,
                "ingress.host": host,

            },
        )

        with Session(engine) as s:
            r = s.get(Store, store_id)
            r.status = "Ready"
            s.commit()

    except Exception as e:
        with Session(engine) as s:
            r = s.get(Store, store_id)
            r.status = "Failed"
            r.last_error = str(e)
            s.commit()

    return {"id": store_id, "namespace": ns, "url": url}

@app.delete("/stores/{store_id}")
def delete_store(store_id: str):
    ns = f"{settings.stores_namespace_prefix}-{store_id}"
    release = f"wc-{store_id}"


    helm_uninstall(release=release, namespace=ns)
    delete_namespace(ns)

    with Session(engine) as s:
        r = s.get(Store, store_id)
        if r:
            s.delete(r)
            s.commit()

    return {"deleted": store_id}
