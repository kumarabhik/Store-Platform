from datetime import datetime
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy import String, DateTime

class Base(DeclarativeBase):
    pass

class Store(Base):
    __tablename__ = "stores"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    engine: Mapped[str] = mapped_column(String, nullable=False)  
    status: Mapped[str] = mapped_column(String, nullable=False)  
    url: Mapped[str] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_error: Mapped[str] = mapped_column(String, nullable=True)
