from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.projects import router as projects_router

app = FastAPI(
    title="Retail Digital Twin API",
    version="1.0.0",
    description="Backend API for the Retail Digital Twin MVP",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects_router)


@app.get("/")
def health():
    return {"status": "ok", "service": "Retail Digital Twin API"}
