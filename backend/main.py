from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.cad_projects import router as cad_router
from api.furniture_library import router as furniture_library_router
from api.projects import router as projects_router
from services.demo_initializer import init_retail_cad_demo

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

init_retail_cad_demo()

app.include_router(projects_router)
app.include_router(cad_router)
app.include_router(furniture_library_router)


@app.get("/")
def health():
    return {"status": "ok", "service": "Retail Digital Twin API"}
